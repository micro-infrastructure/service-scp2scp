FROM mhart/alpine-node:10
RUN apk update && apk add sshfs
RUN mkdir /data
RUN mkdir /assets
RUN mkdir /root/.ssh
RUN mkdir /root/app
ADD app/app.js /root/app/
ADD app/package.json /root/app/
ADD app/config.json /root/app/
RUN cd /root/app && npm install

