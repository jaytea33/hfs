#! /bin/bash
docker build -t hfs .
docker run -d --name hfsserver --network bridge -p 8445:80 hfs
