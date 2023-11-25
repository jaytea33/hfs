#! /bin/bash
docker build -t hfs .
docker run -d --name hfsserver --network bridge -p 8445:80 hfs
echo "Waiting 20 seconds to allow Docker container to exist before copying config"
sleep 20
docker cp config.yaml hfsserver:/root/.hfs/
