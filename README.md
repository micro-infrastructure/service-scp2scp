# Core-copy
#### GET /api/v1/folders
Description: get folder name aliases
Requirements: user x-access-token
Response example: 
```
{
    "krk": {
        "host": "HOST",
        "path": "/net/archive/groups/plggprocess/test",
        "user": ""
    },
    "ams": {
        "host": "HOST",
        "path": "/nfs/scratch/process/test",
        "user": ""
    },
    "snedtn": {
        "host": "HOST",
        "path": "/data/dtn/PROCESS/TEST",
        "user": ""
    },
    "lrzcluster": {
        "host": "HOST",
        "path": "/dss/dssfs01/pn56go/pn56go-dss-0000/process/test",
        "user": ""
    },
    "testlrz": {
        "host": "HOST",
        "path": "/mnt/dss/process/",
        "user": ""
    }
}
```


#### POST /api/v1/list
Description: get list of files in a folder. From v0.2.2 the response paths are relative, not the absolute paths on the host.
Requirements: user x-access-token
Payload type :JSON
Payload example: 
```
{
    "name": "krk",
    "path": "/"
 }
```
Response example (v0.2.0): 
```
[
    "/net/archive/groups/plggprocess/test/",
    "/net/archive/groups/plggprocess/test/10M.dat"
]
```
Response example (v0.2.2): 
```
[
    "/",
    "/10M.dat"
]
```
#### POST /api/v1/remove
Description: remove a file given by a relative path. To recursively remove folders the recursive flag has to be defined in the payload.
Requirements: user x-access-token
Payload type :JSON
Payload example for removing file: 
```
{
    "name": "krk",
    "file": "/10M.dat"
 }
```
Response example: 
```
{
    "stdout": "",
    "stderr": "",
    "startTime": "2020-04-18T14:13:59.009Z",
    "endTime": "2020-04-18T14:13:59.925Z"
}
```
Payload example for removing folder: 
```
{
    "name": "krk",
    "file": "/afolder",
    “recursive”: true
 }
```

Response example: 
```
{
    "stdout": "",
    "stderr": "",
    "startTime": "2020-04-18T14:13:59.009Z",
    "endTime": "2020-04-18T14:13:59.925Z"
}
```
 

v0.2.4
Description: same as previous version but payload can take an array of files/folders to remove. The call only returns after all attempts to remove files have been exhausted. The return payload now returns the status of the files removed.
Requirements: user x-access-token
Payload type :JSON
Payload example for removing file: 
```
[
    {    "name": "krk",     "file": "/folderOne/folderTwo",    "recursive": true     },
    {     "name": "krk",     "file": "/test123/delete_me.dat",     "recursive": false    },
    {     "name": "krk",     "file": "/dir888",     "recursive": true    },
    {     "name": "krk",     "file": "/some_file.dat",     "recursive": false     }
]
```


Response example: 
```
{
    "/some_file.dat": "Ok",
    "/dir888": "Ok",
    "/folderOne/folderTwo": "Ok",
    "/test123/delete_me.dat": "Ok"
}
```
 

POST /api/v1/mkdir
Description: creates directories and subdirectories. The folder permissions are set to 0664.
Requirements: user x-access-token
Payload type :JSON
Payload example: 
```
{
    "name": "krk",
    "path": "/folderOne/folderTwo"
 }
```
Response example: 
```
{
    "stdout": "",
    "stderr": "",
    "startTime": "2020-04-18T14:13:59.009Z",
    "endTime": "2020-04-18T14:13:59.925Z"
}
```
 
 
v0.2.4
Description: Same as previous version but now payload can take an array. The call only returns after all attempts to create dirs are exhausted. The call now returns the status of the created folders i.e. if created or not.
Requirements: user x-access-token
Payload type :JSON
Payload example: 
```
[
    {    "name": "krk",    "path": "/folderOne/folderTwo"    },
    {     "name": "krk",     "path": "/test123"    },
    {     "name": "krk",     "path": "/dir888"    }
    
]
```
Response example: 
```
{
    "/dir888": "Ok",
    "/test123": "Ok",
    "/folderOne/folderTwo": "Ok"
}
```
 

#### POST /api/v1/copy (v0.2.0)
Description: copy files from one location to the other using SCP.
Requirements: user x-access-token
Payload type: JSON
Payload example:
```
{
    "id": "test-1",
    "webhook": {
            "method": "POST",
            "url": "  https://webhook.site/5922e4ee-467a-40eb-9a1a-8579a8f40a00",
            "headers": {
                "custom-header": "value"
            }
     },
    "cmd":
    [
        {
        "dst": {
            "name": "lrzcluster",
            "file": "/"
        },
        "src": {
            "name": "krk",
            "file": "10M.dat"
        }
    }
    
    ]
 }
```

Response example:
```
{
    "id": "test-1",
    "timestamp": "2020-03-06T11:40:26.400Z",
    "trackId": "test-1-JIBfD4HFb9YTpwuRcl3pGR9bo3UOs2tE",
    "webhook": {
        "method": "POST",
        "url": "  https://webhook.site/5922e4ee-467a-40eb-9a1a-8579a8f40a00",
        "headers": {
            "x-access-token": "asfsafdsfasda"
        }
    },
    "counter": 1,
    "files": {},
    "status": "QUEUED"
}
```
 
v0.2.2
Description: copy files from one location to the other using SCP. In version 0.2.2 fdt has been included. This has only been configured to/from snedtn server and lrzdtn server. To choose fdt this is defined in the payload. The default is scp. The permissions are set to 0664 after copy.
Requirements: user x-access-token
Payload type: JSON
Payload example:
```
{
    "id": "test-1",
    "webhook": {
            "method": "POST",
            "url": "  https://webhook.site/5922e4ee-467a-40eb-9a1a-8579a8f40a00",
            "headers": {
                "custom-header": "value"
            }
     },
    "cmd":
    [
        {
        "dst": {
            "name": "lrzcluster",
            "file": "/"
        },
        "src": {
            "name": "krk",
            "file": "/10M.dat"
        },
    protocol: “scp”
    }
    
    ]
 }
```

Response example:
```
{
    "id": "test-1",
    "timestamp": "2020-03-06T11:40:26.400Z",
    "trackId": "test-1-JIBfD4HFb9YTpwuRcl3pGR9bo3UOs2tE",
    "webhook": {
        "method": "POST",
        "url": "  https://webhook.site/5922e4ee-467a-40eb-9a1a-8579a8f40a00",
        "headers": {
            "x-access-token": "asfsafdsfasda"
        }
    },
    "counter": 1,
    "files": {},
    "status": "QUEUED"
}
``` 

#### POST /api/v1/move
Description: moves files from one location to the other using SCP.
Requirements: user x-access-token
Payload type: JSON
Payload example:
```
{
    "id": "test-1",
    "webhook": {
            "method": "POST",
            "url": "  https://webhook.site/5922e4ee-467a-40eb-9a1a-8579a8f40a00",
            "headers": {
                "custom-header": "value"
            }
     },
    "cmd":
    [
        {
        "dst": {
            "name": "lrzcluster",
            "file": "/"
        },
        "src": {
            "name": "krk",
            "file": "10M.dat"
        }
    }
    
    ]
 }
```
Response example:
```
{
    "id": "test-1",
    "timestamp": "2020-03-06T11:40:26.400Z",
    "trackId": "test-1-JIBfD4HFb9YTpwuRcl3pGR9bo3UOs2tE",
    "webhook": {
        "method": "POST",
        "url": "  https://webhook.site/5922e4ee-467a-40eb-9a1a-8579a8f40a00",
        "headers": {
            "x-access-token": "asfsafdsfasda"
        }
    },
    "counter": 1,
    "files": {},
    "status": "QUEUED"
}
```
#### GET /api/v1/status/[trackId]
Description: get status of file copy/move
Requirements: user x-access-token
Response example: 
```
{
    "counter": 0,
    "files": {
        "0": {
            "dst": {
                "file": "/",
                "host": "HOST",
                "name": "lrzcluster",
                "path": "/dss/dssfs01/pn56go/pn56go-dss-0000/process/test//",
                "user": ""
            },
            "duration": 2815,
            "src": {
                "file": "10M.dat",
                "host": "HOST",
                "name": "krk",
                "path": "/net/archive/groups/plggprocess/test/10M.dat",
                "user": ""
            },
            "status": "DONE_COPY",
            "tStart": "2020-03-06T11:40:26.425Z"
        }
    },
    "id": "test-1",
    "status": "DONE_ALL",
    "time": 2840,
    "timestamp": "2020-03-06T11:40:26.400Z",
    "trackId": "test-1-JIBfD4HFb9YTpwuRcl3pGR9bo3UOs2tE",
    "webhook": {
        "headers": {
            "x-access-token": "asfsafdsfasda"
        },
        "method": "POST",
        "url": "  https://webhook.site/5922e4ee-467a-40eb-9a1a-8579a8f40a00"
    }
}
```
