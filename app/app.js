const YAML = require('yaml')
const _ = require('underscore')
const cmdArgs = require('command-line-args')
const express = require('express')
const app = express()
const http = require('http')
const https = require('https')
const bodyParser = require('body-parser')
//const io = require('socket.io')(server)
const request = require('request')
const rp = require('request-promise')
const events = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const redis = require('redis')
const ssh = require('ssh2').Client
const PersistentObject = require('persistent-cache-object')
const kue = require('kue')
const amqp = require('amqplib')
const jwt = require('jsonwebtoken')
const randomstring = require('randomstring')
const eventEmitter = new events.EventEmitter()

const VERSION = "0.2.7"

const cmdOptions = [
	{ name: 'port', alias: 'p', type: Number},
	{ name: 'redis', type: String },
	{ name: 'users', alias: 'u', type: String},
	{ name: 'amqp', type: String },
    { name: 'infraPath', type: String},
    { name: 'netPath', type: String},
	{ name: 'sshPrivateKey', type: String },
	{ name: 'dev', type: Boolean}
]

const options = cmdArgs(cmdOptions)
const DEV = options.dev
const MD5 = false
const infraPath = options.infraPath || '/assets/infra.json'
const netPath = options.netPath || '/assets/network.json'
const usersPath = options.users || '/assets/jwtusers.json'
let infra = (fs.existsSync(infraPath)) ? require(infraPath) : null
let network = (fs.existsSync(netPath)) ? require(netPath) : null
let users = (fs.existsSync(usersPath)) ? require(usersPath) : []

let idRsaFilename = "process_id_rsa"
const token = process.env.TOKEN
const coreApi = process.env.PROCESS_CORE_API
let webdavEp = undefined 


async function getInfraInfo() {
	if(DEV) {
		return null
	}
	const url = "http://" + coreApi + "/api/v1/infrastructure" 
	try{
		const headers = {
			'x-access-token': token,
			'Content-Type': 'application/json'
		}
		console.log("retrieving infra info...")
		
		const result = await rp.get(url, {
			headers: headers
		})
		console.log("[INFO] infra info", result)
		r = JSON.parse(result)
		filterServices = r.services.filter(s => {
			const names = s.name.split('-')
			const name = names[names.length - 1]
			return (name == 'webdav')
		})[0]
		if(filterServices) {
			webdavEp = "http://" + filterServices.entryEndpoints[0] + ":" + filterServices.ports[0]
		}
		console.log(webdavEp)
		return result
	} catch(err) {
		console.log(err)
		console.log("[WARNING] core api not found: " + url)
		return null
	}
}

getInfraInfo()


if(process.env.ID_RSA_FILENAME){
	const f = decodeBase64(process.env.ID_RSA_FILENAME)
	if(fs.existsSync(process.env.HOME + '/.ssh/' + f)) {
		idRsaFilename = f
	}
}

if(network) {
	console.log("loaded network graph graph: ", netPath)
} else {
	network = {
		edges: {},
		nodes: {}
	}
}
if(infra) {
	infra.folders = infra.folders || []
	console.log("loaded infra user infra: ", infraPath)
	console.log(infra.folders)
}
if(users) {
	// list of user's public keys allowed to access the service. Used to check JWT signitature 
	console.log("loaded user certs: ", users)
}

Object.keys(users).forEach(k => {
	const u = users[k]
	u.decodedPublicKey = decodeBase64(u.publicKey)
})

if(!options.sshPrivateKey) {
	const processPath = process.env.HOME + "/.ssh/" + idRsaFilename
	const defaultPath = process.env.HOME + "/.ssh/id_rsa"
	if(fs.existsSync(processPath)) {
		options.sshPrivateKey =  processPath
	} else {
		options.sshPrivateKey =  defaultPath
	}
}

console.log("[INFO] using file " + options.sshPrivateKey + " as id_rsa key file.")

const api = '/api/v1'
const serverPort = options.port || 4300
const amqpHost = options.amqp || 'localhost'
const redisHost = (options.redis) ? options.redis.split(':')[0] : '127.0.0.1'
const redisPort = (options.redis) ? (options.redis.split(':')[1] || 6379) : 6379

// create job queue on redis
const queue = kue.createQueue({
	prefix: 'q',
	redis: {
		host: redisHost,
		port: redisPort
	}
})

// parse infra structure for scp adaptors
const sshAdaptorsWithHosts = {}
const sshAdaptorsWithNames = {}
if(infra) {
	infra.storageAdaptorContainers.forEach(i => {
		sshAdaptorsWithHosts[i.host] = i
		sshAdaptorsWithNames[i.name] = i
	})
}
const trackCopies = new PersistentObject('./trackCopies.db');

// create REST service
const httpServer = http.createServer(app)
app.use(bodyParser.urlencoded({extended: true}))
app.use(bodyParser.json())
app.use(express.static('./'))
app.get('/', function(req, res,next) {
    res.sendFile(__dirname + '/index.html')
})

// setup mq consumer
const consumerHandler = function() {
	let channel = null
	return async function(func) {
		if(channel) return new Promise((resolve, reject) => {
			resolve(channel)
		})
		return new Promise((resolve, reject) => {
			amqp.connect('amqp://' + amqpHost).then(conn => {
				conn.createChannel().then(function(ch) {
					const ex = 'function_proxy'
					ch.assertExchange(ex, 'topic', {durable: false})
					.then(() => {
						ch.assertQueue('', {
							exclusive: true
						})
						.then((q) => {
							ch.bindQueue(q.queue, ex, 'functions.' + func)
							
							channel = function(f) {
								ch.consume(q.queue, f)
							}
							resolve(channel)
							})
					})
				})
			})
		})
	}
}()


function encodeBase64(s) {
	return new Buffer(s).toString('base64')
}

function decodeBase64(d) {
	return new Buffer(d, 'base64').toString()
}

function isEmpty(arr) {
	return arr.length === 0 ? true : false
}

function isHiddenFile(filename) {
	if (!filename) return true
	return path.basename(filename).startsWith('.')
}

function isGoodPath(p) {
	if(!p) {
		return false
	}
	if(p.indexOf('..') > -1) {
		return false
	}
	return true
}

function checkToken(req, res, next) {
	//bypass in dev mode
	if(DEV) {
		next()
		return
	}
	if (req.user) {
		next()
		return
	}
	const token = req.headers['x-access-token']
	if (!token) {
		res.status(403).send()
		return
	}
	const preDecoded = jwt.decode(token)
	if (!preDecoded) {
		res.status(403).send()
	}
	const user = preDecoded.email || preDecoded.user
	if(!users[user]) {
		res.status(403).send()
	}
	if(!users[user]) {
		console.log("[WARN] no cert found for: " + user)
	}

	const cert = users[user].decodedPublicKey
	if (!cert) {
		res.status(403).send()
	}

	jwt.verify(token, cert, {algorithms: ['RS256']}, (err, decoded) => {
		if (err) {
			console.log(err)
			res.status(403).send()
			return
		}
		req['user'] = decoded.email
		next()
	})
}

async function copy(req, res) {
}
// api urls
app.get(api + '/version', (req,res) => {
	res.status(200).send({
		version: VERSION
	})
})

app.post(api + '/move', checkToken, async (req, res) => {
//app.post(api + '/move',  async (req, res) => {
	const copyReq = req.body
	const copies = copyReq.cmd
	const webhook = copyReq.webhook
	const trackId = copyReq.id + '-' + randomstring.generate()
	
	trackCopies[trackId] = {
		id: copyReq.id,
		timestamp: new Date().toISOString(),
		trackId: trackId,
		webhook: webhook,
		counter: copies.length,
		tries: 0,
		files: {},
		//ready: [],
		//error: [],
		status: 'QUEUED'
	}

	res.status(200).send(trackCopies[trackId])

	copies.forEach((c, i) => {
		if (!c.type) c.type = 'move'
		if (c.type == 'move') {
			c.ref = trackId
			c.num = i
			const job = queue.create('copy', c)
				.attempts(3)
				.removeOnComplete(true)
				.save(err => {
					if (err) {
						console.log(err)
						return
					}
				})
			job.on('failed attempt', function(e) {
				const error = JSON.parse(e)
				console.log("failed attempt", error)
			})
			job.on('failed', function(e) {
				if(e) {
					// copy failed so move will fail
					//console.log(e)
					const error = JSON.parse(e)
					console.log("error copying file: ", error)
					finishAndCallWebhook(job)
					return
				}
			})
			job.on('complete', function(r) {
				r.ref = trackId
				r.num = i
				const delJob = queue.create('delete', r)
					.attempts(3)
					.removeOnComplete(true)
					.save(err => {
					if (err) {
						console.log(err)
						return
					}
				})

				delJob.on('complete', function(r) {
					console.log("deleted file from source: ", r)
					finishAndCallWebhook(job)
				})
				delJob.on('failed', function(e) {
					if(e) {
						const error = JSON.parse(e)
						console.log("error moving file: ", error)
						// handle error moving
						finishAndCallWebhook(job)
						return
					}
				})

			})
		} 
	})
})

app.post(api + '/copy', checkToken, async (req, res) => {
//app.post(api + '/copy',  async (req, res) => {
	const copyReq = req.body
	const copies = copyReq.cmd
	const webhook = copyReq.webhook
	const trackId = copyReq.id + '-' + randomstring.generate()
	
	trackCopies[trackId] = {
		id: copyReq.id,
		timestamp: new Date().toISOString(),
		trackId: trackId,
		webhook: webhook,
		counter: copies.length,
		tries: 0,
		files: {},
		//ready: [],
		//error: [],
		status: 'QUEUED'
	}

	res.status(200).send(trackCopies[trackId])

	copies.forEach((c, i) => {
		if (!c.type) c.type = 'copy'
		if (c.type == 'copy') {
			c.ref = trackId
			c.num = i
			queue.create('copy', c)
				.attempts(3)
				.removeOnComplete(true)
				.save(err => {
				if (err) {
					console.log(err)
					return
				}
			})
		} 
	})
})

app.post(api + '/remove', checkToken, async (req, res) => {
	const nodes = (Array.isArray(req.body)) ? req.body : [ req.body ]
	const results = {}
	let cnt = 0

	nodes.forEach(n => {
		const node = translateNames(n)

		if(!isGoodPath(node.file)) {
			res.status(400).send("bad file path")
			return
		}

		const cmd = (node.recursive) ? "rm -rf ": "rm -f "
		const path = node.absRootPath + node.file
		console.log("[INFO] removing file/dir: ", path)
		sshCommand(node, cmd + path).then(r => {
			cnt += 1
			if(r.stderr) {
				results[node.relPath] = "Error: " + r.stderr
			} else {
				results[node.relPath] = "Ok"
			}
		}).catch(e => {
			cnt += 1
			results[node.relPath] = "Error: " + e
			console.log(e)
		})
	})
	
	const interval = setInterval(()=> {
		if(cnt >= nodes.length) {
			clearInterval(interval)
			res.status(200).send(results)
		}
	}, 500)
})

app.post(api + '/mkdir', checkToken, async (req, res) => {
	const nodes = (Array.isArray(req.body)) ? req.body : [ req.body ]
	const results = {}
	let cnt = 0
	nodes.forEach(n => {
		const node = translateNames(n)
		if(!isGoodPath(node.path)) {
			res.status(400).send("bad file path")
			return
		}

		console.log("[INFO] creating dirs: ", node.path)
		sshCommand(node, 'umask 002 && mkdir -p -m 0774 ' + node.path).then(r => {
			cnt += 1
			if(r.stderr) {
				results[node.relPath] = "Error: " + r.stderr
			} else {
				results[node.relPath] = "Ok"
			}
		}).catch(e => {
			cnt += 1
			results[node.relPath] = "Error: " + e
			console.log(e)
		})
	})

	const interval = setInterval(()=> {
		if(cnt >= nodes.length) {
			clearInterval(interval)
			res.status(200).send(results)
		}
	}, 500)


})

app.post(api + '/list', checkToken, async (req, res) => {
	const node = translateNames(req.body)
	if(!isGoodPath(node.path)) {
		res.status(400).send("bad file path")
		return
	}
	const opts = (node.recursive) ? "" : " -maxdepth 1 "
	sshCommand(node, 'find ' + node.path + opts).then(r => {
		const out = r.stdout.split('\n').map(e => {
			return e.replace(node.absRootPath, '')
		}).filter(e => {
			return e
		})
		res.status(200).send(out)
	}).catch(e => {
		console.log(e)
		res.status(500).send(e)
	})
})

app.get(api + '/folders',  checkToken, async (req, res) => {
	const results = {}
	Object.keys(sshAdaptorsWithNames).forEach(k => {
		const v = sshAdaptorsWithNames[k]
		results[k] = {
			host: v.host,
			path: v.path,
			user: v.user
		}
	})
	infra.folders.forEach(f => {
		results[f.name] = {
			host: f.host,
			path: f.folder,
			user: f.user
		}
	})
	res.status(200).send(results)
})

app.get(api + '/status/:trackId',  checkToken, async (req, res) => {
//app.get(api + '/status/:trackId', async (req, res) => {
	const trackId = req.params.trackId
	res.status(200).send(trackCopies[trackId])
})

app.delete(api + '/job/:trackId',  checkToken, async (req, res) => {
	const trackId = req.params.trackId
	const doc = trackCopies[trackId]
	if(!doc) {
		res.status(404).send()
		return
	}
	doc.status = "CANCELLED"	
	res.status(200).send()
})

function trim(s) {
	if (!s) return ''
	return s.replace(/^\s+|\s+$/g,'')
}

function sshCommand2(node, cmd, close) {
	return new Promise((resolve, reject) => {
		const conn = new ssh()
		let stdout = ''
		let stderr = ''
		const startTime = new Date().toISOString();
		conn.on('error', err => {
			reject(err)
		})
		conn.on('ready', () => {
			//console.log('[' + node.host + '] connected')
			conn.exec(cmd, (err, stream) => {
				if (err) reject(err)
				// resolve immediately
				// use callback to signal return of blocking call
				resolve()
				stream.on('close', (code, signal) => {
					conn.end()
					if(close) {
						close(null, { 
							stdout: stdout,
							stderr: stderr,
							startTime: startTime,
							endTime: new Date().toISOString()
						})
					}
				}).on('data', data => {
					//console.log("[" + node.host + "][" + cmd + "][stdout] " + trim(data.toString('utf-8')))
					stdout += data.toString('utf-8') + '\n'
				}).stderr.on('data', data => {
					//console.log("[" + node.host + "][" + cmd + "][stderr] " + trim(data.toString('utf-8')))
					stderr += data.toString('utf-8')
				})
			})
		}).connect({
			host: node.host,
			port: node.port || 22,
			username: node.user,
			//privateKey: require('fs').readFileSync(process.env.HOME + "/.ssh/process_id_rsa")
			privateKey: require('fs').readFileSync(options.sshPrivateKey)
		})
	})
}
function sshCommand(node, cmd) {
	return new Promise((resolve, reject) => {
		const conn = new ssh()
		let stdout = ''
		let stderr = ''
		const startTime = new Date().toISOString();
		conn.on('error', err => {
			reject(err)
		})
		conn.on('ready', () => {
			//console.log('[' + node.host + '] connected')
			conn.exec(cmd, (err, stream) => {
				if (err) reject(err)
				stream.on('close', (code, signal) => {
					conn.end()
					resolve({
						stdout: stdout,
						stderr: stderr,
						startTime: startTime,
						endTime: new Date().toISOString()
					})
				}).on('data', data => {
					//console.log("[" + node.host + "][" + cmd + "][stdout] " + trim(data.toString('utf-8')))
					stdout += data.toString('utf-8') + '\n'
				}).stderr.on('data', data => {
					//console.log("[" + node.host + "][" + cmd + "][stderr] " + trim(data.toString('utf-8')))
					stderr += data.toString('utf-8')
				})
			})
		}).connect({
			host: node.host,
			port: node.port || 22,
			username: node.user,
			//privateKey: require('fs').readFileSync(process.env.HOME + "/.ssh/process_id_rsa")
			privateKey: require('fs').readFileSync(options.sshPrivateKey)
		})
	})
}

function translateNames(s) {
	folders = {}
	infra.folders.forEach(f => {
		folders[f.name] = f
	})
	if(s.file) {
		if(s.file.substring(0,1) != '/') {
			s.file = '/' + s.file
		}
	}
	if(!sshAdaptorsWithNames[s.name]) sshAdaptorsWithNames[s.name] = {}
	if(!folders[s.name]) folders[s.name] = {}
	s.host = s.host || sshAdaptorsWithNames[s.name]['host'] || folders[s.name]['host']
	s.user = s.user || sshAdaptorsWithNames[s.name]['user'] || folders[s.name]['user']
	s.relPath = s.path
	s.path = s.path || '/' || sshAdaptorsWithNames[s.name]['path'] || folders[s.name]['folder'] 

	if(s.path.slice(-1) != '/') {
		s.path += '/'
	}
	s.absRootPath = sshAdaptorsWithNames[s.name]['path'] || folders[s.name]['folder']
	if(s.file) {
		s.path += s.file
		s.relPath = s.path.replace('//','/')
		s.absFullPath = s.absRootPath + s.file
	} else {
		const relPath = s.path
		s.path = sshAdaptorsWithNames[s.name]['path'] || folders[s.name]['folder'] 
		s.path +=  '/' + relPath
		s.path = s.path.replace('//', '/')
	}

	return s
}

function sshCopy(src, dst) {
	src = translateNames(src)
	dst = translateNames(dst)

	console.log("src: ", src)
	console.log("dst: ", dst)
	let error = ""
	return new Promise(async(resolve, reject) => {
		try{
			//const exists = await remoteFileExists(src)
			const exists = await remoteFileStat(src)
			if(!exists) {
				console.log("file does not exist " + src.file)
				reject("source file not exists.")
				return
			} else {
				src.size = exists.size
				src.type = exists.type
			}
		}catch(err){
			console.log(err)
			reject(err)
			return
		}
		const conn = new ssh()
		conn.on('error', (err) => {
			console.log(err)
			reject(err)
		})
		conn.on('ready', () => {
			console.log("[SSH] connected")
			//const cmd = 'scp -i .ssh/process_id_rsa -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -q ' + src.absFullPath + " " + dst.user + '@' + dst.host + ":" + dst.absFullPath + '/'
			const cmd = 'rsync -a --chmod=2775 --append-verify -e "ssh -i .ssh/process_id_rsa -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" ' + src.absFullPath + " " + dst.user + '@' + dst.host + ":" + dst.absFullPath + '/'
			console.log("cmd: ", cmd)
			conn.exec(cmd, (err, stream) => {
				if (err) reject(err)
				stream.on('close', (code, signal) => {
					console.log("[SCP] close")
					conn.end()
					dst.endCopyTime = new Date().toISOString()
					if(MD5) {
						getHashOfDstAndSrc(src, dst).then(r => {
							console.log("src, dst hash: ", r)
							if((r.src.md5sum) && (r.src.md5sum == r.dst.md5sum)) {
								console.log("hash match.")
								src.md5sum = r.src.md5sum
								dst.md5sum = r.dst.md5sum
								resolve({
									src: src,
									dst: dst
								})
							} else {
								console.log("hash mismatch")
								reject("hash mismatch")
							}
						}).catch(err => {
							console.log(err)
							reject("calc hash error")
						})
					} else {
						if(error) {
							reject(error)
						} else {
							resolve({
								src: src,
								dst: dst
							})
						}
					}
				}).on('data', (data) => {
					console.log("[SCP STDOUT] " + data)
				}).stderr.on('data', (data) => {
					console.log("[SCP STDERR] " + data)
					if(data.indexOf("rsync") > -1) {
						error = error + " " + data
					}
				})
			})
		}).connect({
			host: src.host,
			port: 22,
			username: src.user,
			privateKey: require('fs').readFileSync(options.sshPrivateKey)
		})
		//TODO
	})
}

async function setupCharlieServer(s) {
	console.log("Charlie: ", s)
	const imageFile = s.protocols.fdt.imageName
	const image = imageFile.replace('.tar.gz','');
	const serverPort = s.openTcpPorts[0]
	const preCommands = s.protocols.fdt.preCommands.join(' && ')
	const setupCommands = [
		"mkdir -p .charliecloud",
		"module load charliecloud && ch-tar2dir " + imageFile + " .charliecloud/"
	]
	const runCmd = "module load charliecloud && ch-run -c /app/ .charliecloud/" + image + " -- bash server " + serverPort
	const paths = s.protocols.fdt.bindPaths
	if(s.details.path) {
		paths.push(s.details.path+":/data")
	}
	const node = {
		host: s.details.host,
		user: s.details.user
	}
	setupCommands.push(runCmd)
	sshCommand(node, setupCommands[1]).then(r => {
		console.log("done1: ", r)
		sshCommand(node, setupCommands[2]).then(rr => {
			console.log("done2: ", rr)
		}).catch(ee => {
			console.log(ee)
		})
	}).catch(e => {
		console.log(e)
	})
	/*setupCommands.forEach(async c => {
		try{
			console.log("running command: ", c)
			const r = await(sshCommand(node, c))
			console.log(r)
		}catch(err){
			console.log(err)
		}
	})
	// run cmd
	/*try{
		console.log("running command: ", runCmd)
		console.log("on: ", node)
		const r = await(sshCommand(node, runCmd))
		console.log(r)
	}catch(err){
		console.log(err)
	}*/
	
	
	
}

let ourPids = {}

async function setupSingularityServer(s, cb) {
	console.log("Singularity: ", s)
	const setupCommands = []
	const imageFile = s.protocols.fdt.imageName
	const serverPort = s.openTcpPorts[0]
	//const preCommands = s.protocols.fdt.preCommands.join(' && ')
	const pidCmd = "ps aux | grep '" + 
		s.protocols.fdt.processPattern.replace("$PORT", serverPort) + "'" +
		" | grep -v grep | awk '{print $2}'"
	const killCmd = pidCmd + " | xargs kill -9"

	const path = s.path + ":" + s.protocols.fdt.bindCntPath
	const runCmd = "singularity run -B " + path + " " + imageFile + " server " + serverPort
	const node = {
		host: s.details.host,
		user: s.details.user
	}
	const r = await sshCommand(node, pidCmd)
	const pid = (r.stdout) ? parseInt(r.stdout) : null

	console.log("PID: ", pid)

	/*TODO solve hanging process....
	 * if((pid) && (!ourPids[pid])) {
		console.log("Running service by someone else.....killing.")
		const r = await sshCommand(node, killCmd)
	}*/
	if((pid) && (ourPids[pid])) {
		console.log("Already running: ", ourPids[pid])
		cb(null, r)
		return
	} else if(!pid) {
		setupCommands.push(runCmd)
		for(i=0; i < setupCommands.length; i++){
			const c = setupCommands[i]
			console.log("run cmd: ", c)
			const r = await sshCommand2(node, c, (err, res) => {
				console.log("return from cmd: ", c)
				//console.log("response: ", res)
			})
		}
		cb(null, r)
		/*const checkPid = await sshCommand(node, pidCmd)
		const newPid = (r.stdout) ? parseInt(r.stdout) : null
		if(newPid) {
			ourPids[newPid] = runCmd
			console.log(ourPids)
		} else {
			console.log("No pid found!!")
		}*/
		// TODO
		// find a way to stop service after copy.

	} else {
		console.log("Running service by someone else.")
	}
}

async function copySingularityClient(s, c) {
	console.log("Singularity client")
	const imageFile = c.protocols.fdt.imageName
	const serverPort = s.openTcpPorts[0]
	const srcFile = c.protocols.fdt.bindCntPath + "/" + c.details.file
	const dstFile = s.details.host + ":" + serverPort +":" + s.protocols.fdt.bindCntPath + "/" 
	const path = c.path + ":" + c.protocols.fdt.bindCntPath
	console.log(s)
	console.log(c)
	const setupCommands = []
	const runCmd = "singularity run -B " + path + " " + imageFile + " copy " + srcFile + " " + dstFile
	const node = {
		host: c.details.host,
		user: c.details.user
	}
	setupCommands.push(runCmd)
	for(i=0; i < setupCommands.length; i++){
		const c = setupCommands[i]
		console.log("run cmd: ", c)
		const r = await sshCommand(node, c)
		//console.log("copy done: ", r)
	}
}

function fdtCopy(src, dst) {
	console.log("fdt copy...")
	src = translateNames(src)
	dst = translateNames(dst)


	console.log("src: ", src)
	console.log("dst: ", dst)

	const srcNode = network.nodes[src.name]
	const dstNode = network.nodes[dst.name]


	return new Promise(async (resolve, reject) => {
		try{
			const exists = await remoteFileExists(src)
			if(!exists) {
				console.log("file does not exist " + src.file)
				reject("source file not exists.")
				return
			}
		}catch(err){
			console.log(err)
			reject(err)
			return
		}

		let server = null
		let client = null
		// choose server and client
		if(dstNode.openTcpPorts.length > 0) {
			// set server
			server = dstNode
			server.name = dst.name
			server.path = dst.absRootPath
			server.details = dst
			client = srcNode
			client.name = src.name
			client.path = src.absRootPath
			client.details = src
		} else if (srcNode.openTcpPorts.length > 0) {
			server = srcNode
			server.name = src.name
			server.path = src.absRootPath
			server.details = src
			client = dstNode
			client.name = dst.name
			client.path = dst.absRootPath
			client.details = dst
		}
		if (!server) {
			// no communication possible
			reject()
		}
		// set up server node
		const fdtServer = server.protocols.fdt
		if(fdtServer.cntInterface == "charliecloud") {
			//setupCharlieServer(server)
			// not implemented
			reject("charlie cloud not implemented")
		}
		if(fdtServer.cntInterface == "singularity") {
			setupSingularityServer(server, async (err, r) => {
					if(err) {
						reject("setup server error: ", err)
						return
					}
					// set up client node
					// copy file
					copySingularityClient(server, client).then(() => {
						dst.endCopyTime = new Date().toISOString()
						getHashOfDstAndSrc(src, dst).then(r => {
							console.log("src, dst hash: ", r)
							if((r.src.md5sum) && (r.src.md5sum == r.dst.md5sum)) {
								console.log("hash match.")
								src.md5sum = r.src.md5sum
								dst.md5sum = r.dst.md5sum
								resolve({
									src: src,
									dst: dst
								})
							}
						}).catch(err => {
							console.log(err)
							reject("calc hash error")
						})
					}).catch(err => {
						console.log(err)
						reject("copy error")
					})
			})
		}
		// tear down client node
		// tear down server node
	})
}

function remoteFileExists(src) {
	console.log("checking file exists: ", src)
	return new Promise((resolve, reject) => {
		const srcNode = {
			host: src.host,
			user: src.user,
			file: src.absFullPath
		}
		sshCommand(srcNode, 'ls ' + srcNode.file).then(r => {
			console.log("return from test -f " + srcNode.file)
			if(r.stdout) {
				resolve(true)
			} else {
				resolve(false)
			}
		}).catch(e => {
			console.log(e)
			reject(e)
		})
	})
}

function remoteFileStat(src) {
	console.log("checking file stat: ", src)
	return new Promise((resolve, reject) => {
		const srcNode = {
			host: src.host,
			user: src.user,
			file: src.absFullPath
		}
		sshCommand(srcNode, 'stat ' + srcNode.file).then(r => {
			console.log("return from test -f " + srcNode.file)
			if(r.stdout) {
				const stats = r.stdout.split('\n')[1].split(/[ ]+/)
				const type = stats[8].replace('regular', 'file')
				// type: directory | file | symbolic
				resolve({
					size: stats[2],
					type: type
				})
			} else {
				resolve(false)
			}
		}).catch(e => {
			console.log(e)
			reject(e)
		})
	})
}

function getHashOfDstAndSrc(src, dst) {
	console.log("calculating src, dst hash.")
	return new Promise((resolve, reject) => {
		const dstNode = {
			host: dst.host,
			user: dst.user,
			file: dst.absFullPath + '/' + path.basename(src.path)
		}
		const srcNode = {
			host: src.host,
			user: src.user,
			file: src.absFullPath
		}

		sshCommand(dstNode, 'md5sum ' + dstNode.file).then(r => {
			dstNode.md5sum = r.stdout.split(' ')[0]
			sshCommand(srcNode, 'md5sum ' + srcNode.file).then(r => {
				srcNode.md5sum = r.stdout.split(' ')[0]
				resolve({
					src: srcNode,
					dst: dstNode
				})
			}).catch(e => {
				console.log(e)
				reject(e)
			})
		}).catch(e => {
			console.log(e)
			reject(e)
		})
	})
}

queue.process('delete', async (job, done) => {
	console.log("delete type job: ", job.data)
	const trackId = job.data.ref
	const copyId = job.data.num
	const doc = trackCopies[trackId]
	const track = doc.files[copyId]

	if(doc.status == "CANCELLED") {
		done("CANCELLED")
		return
	}

	track.status = "START_DELETE"
	doc.status = "IN_PROGRESS"
	getHashOfDstAndSrc(job.data.src, job.data.dst).then(r => {
		if(r.src.md5sum == r.dst.md5sum) {
			// OK to delete src
			sshCommand(r.src, 'rm -f ' + r.src.file).then(() => {
				track.status = "DONE_DELETE"
				done(null, r)
			}).catch(e => {
				track.status = "ERROR_DELETE"
				track.errorDetails = e
				const error = {
					type: "UNKNOWN",
					details: e,
					files: r
				}
				done(JSON.stringify(error))
			})
		} else {
			track.status = "ERROR_DELETE"
			track.errorDetails = "HASH_MISMATCH"
			const error = {
				type: "HASH_MISMATCH",
				details: null,
				files: r
			}
			done(JSON.stringify(error))
		}
	}).catch(e => {
			done(JSON.stringify(e))
	})
})

async function finishAndCallWebhook(job) {
	const trackId = job.data.ref
	const copyId = job.data.num
	const doc = trackCopies[trackId]
	const track = doc.files[copyId]
	const tDiff = new Date() - new Date(track.tStart)
	trackCopies[trackId]['counter'] -= 1
	/*trackCopies[trackId]['ready'].push({
				time: tDiff,
				src: job.data.src,
				dst: job.data.dst
	})*/
	if(trackCopies[trackId]['counter'] <= 0) {
		trackCopies[trackId]['status'] = "DONE_ALL"
		trackCopies[trackId]['time'] = new Date() - new Date(trackCopies[trackId]['timestamp'])
		const wh = trackCopies[job.data.ref]['webhook']
		if (wh) {
			try{
				console.log("calling webhook")
				await rp.post(wh.url, {
					headers: wh.headers,
					json: {
						id: job.data.id,
						//status: trackCopies[trackId]['status'],
						details: trackCopies[trackId]
					}
				})
			} catch(err) {
				console.log("[ERROR] calling webhook: " + wh.url)
				trackCopies[trackId].status += ";WEBHOOK_CALL_ERROR"
				//console.log(err)
			}
		}
	}
}

queue.process('copy', async (job, done) => {
	console.log("processing job: " + JSON.stringify(job))
	let status = 'done'
	const trackId = job.data.ref
	const copyId = job.data.num
	const doc = trackCopies[trackId]

	if(doc.status == "CANCELLED") {
		done("CANCELLED")
		return
	}

	doc.files[copyId] = {
		src: job.data.src,
		dst: job.data.dst
	}
	const track = doc.files[copyId]
	const tStart = new Date().toISOString()
	track.tStart = tStart
	try {	
		const edgeId = job.data.src.name+'->'+job.data.dst.name
		const edge = network.edges[edgeId] || { 
			protocolPreference: ['scp']
		}
		if(job.data.protocol) {
			edge.protocolPreference = [job.data.protocol]
		}
		track.status = "START_COPY"
		doc.status = "IN_PROGRESS"
		for(let p of edge.protocolPreference) {
			if(p == 'fdt') {
				const out = await(fdtCopy(job.data.src, job.data.dst, null))
				track.src.md5sum = out.src.md5sum
				track.dst.md5sum = out.dst.md5sum
				break
			}
			if(p == 'scp') {
				const out = await(sshCopy(job.data.src, job.data.dst, null))
				track.src.md5sum = out.src.md5sum
				track.dst.md5sum = out.dst.md5sum
				break
			}
			throw("Error", "no protocol handler: " + p)
		}
		track.status = "DONE_COPY"
		const pathName = (job.data.dst.name + "/" + job.data.dst.file + "/" + path.basename(job.data.src.path)).split('//').join('/')
		track.webdavLink = (webdavEp) ? webdavEp  + "/" + pathName : undefined
		const tDiff = new Date() - new Date(tStart)
		track.dst.totalDuration = tDiff
		track.dst.copyDuration = new Date(track.dst.endCopyTime) - new Date(tStart) 
	}catch(err) {
		console.log(err)
		status = 'error'
		track.status = "ERROR_COPY"
		track.errorDetails = err
	}
	if(job.data.type == "copy") {
		finishAndCallWebhook(job)
	}
	const error = (track.errorDetails) ? JSON.stringify({
		status: track.status,
		details:  track.errorDetails
	}) : null

	done(error, {
		src: job.data.src,
		dst: job.data.dst
	})
})

queue.on('job enqueue', function(id, type){
	console.log( 'Job %s got queued of type %s', id, type );
}).on('job complete', function(id, result){
  kue.Job.get(id, function(err, job){
    if (err) return
    job.remove(function(err){
      if (err) throw err
      console.log('removed completed job #%d', job.id)
    })
  })
})

function verifyJob(job) {
	if (!job.name) return false
	if (!job.type) return false
	if (!job.path) return false
	if (!job.params) return false
	if (!job.webhook) return false
	if (!job.ouptut) return false

	return true
}

console.log("Starting server on port: " + serverPort)
httpServer.listen(serverPort)

