### Or Use Touch Comand to make Dockerfile on host (i.e. /tmp/hfstemp/)
 
FROM node:alpine
WORKDIR /app
COPY . .
RUN npm -g i hfs
EXPOSE 80
CMD ["hfs", "src/package.json"]

###End of Dockerfile
