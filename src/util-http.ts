// This file is part of HFS - Copyright 2021-2023, Massimo Melina <a@rejetto.com> - License https://www.gnu.org/licenses/gpl-3.0.txt

import { RequestOptions } from 'https'
import http, { IncomingMessage } from 'node:http'
import https from 'node:https'
import _ from 'lodash'

// in case the response is not 2xx, it will throw and the error object is the Response object
export function httpString(url: string, options?: XRequestOptions): Promise<string> {
    return httpStream(url, options).then(res =>
        new Promise(resolve => {
            let buf = ''
            res.on('data', chunk => buf += chunk.toString())
            res.on('end', () => {
                if (!_.inRange(res.statusCode!, 200, 299))
                    throw res
                resolve(buf)
            })
        })
    )
}

export interface XRequestOptions extends RequestOptions { body?: string | Buffer }
export function httpStream(url: string, { body, ...options }:XRequestOptions ={}): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        if (body)
            options.method ||= 'POST'
        const proto = url.startsWith('https:') ? https : http
        const req = proto.request(url, options, res => {
            console.debug("http responded", res.statusCode, "to", url)
            if (!res.statusCode || res.statusCode >= 400)
                return reject(new Error(String(res.statusCode), { cause: res }))
            if (res.headers.location)
                return resolve(httpStream(res.headers.location, options))
            resolve(res)
        }).on('error', e => {
            reject((req as any).res || e)
        })
        req.end(body)
    })
}

