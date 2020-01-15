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

const cmdOptions = [
	{ name: 'port', alias: 'p', type: Number},
	{ name: 'redis', type: String },
	{ name: 'users', alias: 'u', type: String},
	{ name: 'amqp', type: String },
    { name: 'infraPath', type: String},
	{ name: 'sshPrivateKey', type: String }
]

const options = cmdArgs(cmdOptions)
const infraPath = options.infraPath || '/asstes/infra.json'
const infra = (fs.existsSync(infraPath)) ? require(infraPath) : null

// list of user's public keys allowed to access the service. Used to check JWT signitature 
const users = (options.users) ? require(options.users) : {}
Object.keys(users).forEach(k => {
	const u = users[k]
	u.decodedPublicKey = decodeBase64(u.publicKey)
})

if(!options.sshPrivateKey) {
	//options.sshPrivateKey =  require('fs').readFileSync(process.env.HOME + "/.ssh/id_rsa")
	options.sshPrivateKey =  process.env.HOME + "/.ssh/id_rsa"
}

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

function checkToken(req, res, next) {
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

/*consumerHandler('*.scp2scp.copy').then(ch => {
	ch(msg => {
		const msgBody = JSON.parse(msg.content.toString())
		const copyReq = msgBody.body
		console.log(copyReq.cmd.type)
		queue.create('copy', copyReq).save(err => {
			if (err) {
				console.log(err)
				return
			}
			// send reply over msgq
		})

	})
})*/

// api urls
//app.post(api + '/copy', checkToken, async (req, res) => {
app.post(api + '/copy',  async (req, res) => {
	const copyReq = req.body
	const copies = copyReq.cmd
	const webhook = copyReq.webhook
	const trackId = copyReq.id + '-' + randomstring.generate()
	
	trackCopies[trackId] = {
		id: copyReq.id,
		trackId: trackId,
		webhook: webhook,
		counter: copies.length,
		ready: [],
		status: 'submitted'
	}

	res.status(200).send(trackCopies[trackId])

	copies.forEach(c => {
		if (!c.type) c.type = 'copy'
		if (c.type == 'copy') {
			c.ref = trackId
			queue.create('copy', c).save(err => {
				if (err) {
					console.log(err)
					return
				}
			})
		} 
	})
})
// TODO
//app.get(api + '/endpoints',  checkToken, async (req, res) => {
app.get(api + '/endpoints',  async (req, res) => {
	const results = {}
	Object.keys(sshAdaptorsWithNames).forEach(k => {
		const v = sshAdaptorsWithNames[k]
		results[k] = {
			host: v.host,
			path: v.path,
			user: v.user
		}
	})
	res.status(200).send(results)
})

//app.get(api + '/status/:trackId',  checkToken, async (req, res) => {
app.get(api + '/status/:trackId', async (req, res) => {
	const trackId = req.params.trackId
	res.status(200).send(trackCopies[trackId])
})

function sshCopy(src, dst) {
	src.host = src.host || sshAdaptorsWithNames[src.name]['host']
	src.user = src.user || sshAdaptorsWithNames[src.name]['user']
	src.path = src.path || sshAdaptorsWithNames[src.name]['path'] + '/' + src.file
	
	dst.host = dst.host || sshAdaptorsWithNames[dst.name]['host']
	dst.user = dst.user || sshAdaptorsWithNames[dst.name]['user']
	dst.path = dst.path || sshAdaptorsWithNames[dst.name]['path'] + '/' + dst.file

	return new Promise((resolve, reject) => {
		const conn = new ssh()
		conn.on('error', (err) => {
			console.log(err)
			reject(err)
		})
		conn.on('ready', () => {
			console.log("[SSH] connected")
			const cmd = 'scp ' + src.path + " " + dst.user + '@' + dst.host + ":" + dst.path
			conn.exec(cmd, (err, stream) => {
				if (err) reject(err)
				stream.on('close', (code, signal) => {
					console.log("[SCP] close")
					conn.end()
					resolve({
						src: src,
						dst: dst
					})
				}).on('data', (data) => {
					console.log("[SCP STDOUT] " + data)
				}).stderr.on('data', (data) => {
					console.log("[SCP STDERR] " + data)
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

/*sshCopy({
	host: 'pro.cyfronet.pl',
	user: 'plgcushing',
	path: '10M.dat'
}, {
	host: 'lisa.surfsara.nl',
	user: 'cushing',
	path: ''
}, null)*/

queue.process('copy', async (job, done) => {
	console.log("processing job: " + JSON.stringify(job))
	const type = job.data.subtype || 'scp2scp'
	
	if (type == 'scp2scp') {
		const trackId = job.data.ref
		const j = await(sshCopy(job.data.src, job.data.dst, null))
		trackCopies[trackId]['counter'] -= 1
		trackCopies[trackId]['ready'].push({
					src: job.data.src,
					dst: job.data.dst
		})
		if(trackCopies[trackId]['counter'] <= 0) {
			trackCopies[trackId]['status'] = 'done'
			const wh = trackCopies[job.data.ref]['webhook']
			if (wh) {
				try{
					console.log("calling webhook")
					await rp.post(wh.url, {json: {
						id: job.data.id,
						status: 'done',
						details: job.data
					}})
				} catch(err) {
					console.log(err)
				}
			}
		}
	}
	
	done()
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

console.log("Starting server...")
httpServer.listen(options.port || 4300)

