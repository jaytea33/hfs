// This file is part of HFS - Copyright 2021-2023, Massimo Melina <a@rejetto.com> - License https://www.gnu.org/licenses/gpl-3.0.txt

import * as http from 'http'
import { defineConfig } from './config'
import { app } from './index'
import * as https from 'https'
import { watchLoad } from './watchLoad'
import { networkInterfaces } from 'os';
import { newConnection } from './connections'
import open from 'open'
import { debounceAsync, ipForUrl, objSameKeys, onlyTruthy, runAt, wait, waitFor } from './misc'
import { ADMIN_URI, argv, DEV, IS_WINDOWS } from './const'
import findProcess from 'find-process'
import { anyAccountCanLoginAdmin } from './adminApis'
import _ from 'lodash'
import { X509Certificate } from 'crypto'
import events from './events'
import { isIPv6 } from 'net'
import { defaultBaseUrl } from './nat'

interface ServerExtra { name: string, error?: string, busy?: Promise<string> }
let httpSrv: undefined | http.Server & ServerExtra
let httpsSrv: undefined | http.Server & ServerExtra

const openBrowserAtStart = defineConfig('open_browser_at_start', !DEV)

export const baseUrl = defineConfig('base_url', '')

export function getBaseUrlOrDefault() {
    return baseUrl.get() || defaultBaseUrl.get()
}

export function getHttpsWorkingPort() {
    return httpsSrv?.listening && (httpsSrv.address() as any)?.port
}

const commonOptions = { requestTimeout: 0 }

const considerHttp = debounceAsync(async () => {
    await waitFor(() => app)
    stopServer(httpSrv).then()
    httpSrv = Object.assign(http.createServer(commonOptions as any, app.callback()), { name: 'http' })
    const port = await startServer(httpSrv, { port: portCfg.get(), host: listenInterface.get() })
    if (!port) return
    httpSrv.on('connection', newConnection)
    printUrls(httpSrv.name)
    if (openBrowserAtStart.get() && !argv.updated)
        openAdmin()
})

export const portCfg = defineConfig<number>('port', 80)
const listenInterface = defineConfig('listen_interface', '')
portCfg.sub(considerHttp)
listenInterface.sub(considerHttp)

export function openAdmin() {
    for (const srv of [httpSrv, httpsSrv]) {
        const a = srv?.address()
        if (!a || typeof a === 'string') continue
        const baseUrl = srv!.name + '://localhost:' + a.port
        open(baseUrl + ADMIN_URI, { wait: true}).catch(async e => {
            console.debug(String(e))
            console.warn("cannot launch browser on this machine >PLEASE< open your browser and reach one of these (you may need a different address)",
                ...Object.values(await getUrls()).flat().map(x => '\n - ' + x + ADMIN_URI))
            if (! anyAccountCanLoginAdmin())
                console.log(`HINT: you can enter command: create-admin YOUR_PASSWORD`)
        })
        return true
    }
    console.log("openAdmin failed")
}

export function getCertObject() {
    if (!httpsOptions.cert) return
    const o = new X509Certificate(httpsOptions.cert)
    const some = _.pick(o, ['subject', 'issuer', 'validFrom', 'validTo'])
    return objSameKeys(some, v => v?.includes('=') ? Object.fromEntries(v.split('\n').map(x => x.split('='))) : v)
}

const considerHttps = debounceAsync(async () => {
    stopServer(httpsSrv).then()
    defaultBaseUrl.proto = 'http'
    defaultBaseUrl.port = getCurrentPort(httpSrv) ?? 0
    let port = httpsPortCfg.get()
    try {
        while (!app)
            await wait(100)
        httpsSrv = Object.assign(
            https.createServer(port === PORT_DISABLED ? {} : { ...commonOptions, key: httpsOptions.private_key, cert: httpsOptions.cert }, app.callback()),
            { name: 'https' }
        )
        if (port >= 0) {
            const cert = getCertObject()
            if (!cert) return
            const cn = cert.subject?.CN
            if (cn)
                console.log("certificate loaded for", cn)
            const now = new Date()
            const from = new Date(cert.validFrom)
            const to = new Date(cert.validTo)
            updateError() // error will change at from and to dates of the certificate
            const cancelTo = runAt(to.getTime(), updateError)
            const cancelFrom = runAt(from.getTime(), updateError)
            httpsSrv.on('close', () => {
                cancelTo()
                cancelFrom()
            })
            function updateError() {
                if (!httpsSrv) return
                httpsSrv.error = from > now ? "certificate not valid yet" : to < now ? "certificate expired" : undefined
            }

            const namesForOutput: any = { cert: 'certificate', private_key: 'private key' }
            const missing = httpsNeeds.find(x => !x.get())?.key()
            if (missing)
                return httpsSrv.error = "missing " + namesForOutput[missing]
            const cantRead = httpsNeeds.find(x => !httpsOptions[x.key() as HttpsKeys])?.key()
            if (cantRead)
                return httpsSrv.error = "cannot read " + namesForOutput[cantRead]
        }
    }
    catch(e) {
        httpsSrv!.error = "bad private key or certificate"
        console.log("failed to create https server: check your private key and certificate", String(e))
        return
    }
    port = await startServer(httpsSrv, { port, host: listenInterface.get() })
    if (!port) return
    httpsSrv.on('connection', newConnection)
    printUrls(httpsSrv.name)
    events.emit('https ready')
    defaultBaseUrl.proto = 'https'
    defaultBaseUrl.port = getCurrentPort(httpsSrv) ?? 0
})


export const cert = defineConfig('cert', '')
export const privateKey = defineConfig('private_key', '')
const httpsNeeds = [cert, privateKey]
const httpsOptions = { cert: '', private_key: '' }
type HttpsKeys = keyof typeof httpsOptions
for (const cfg of httpsNeeds) {
    let unwatch: ReturnType<typeof watchLoad>['unwatch']
    cfg.sub(async v => {
        unwatch?.()
        const k = cfg.key() as HttpsKeys
        httpsOptions[k] = v
        if (!v || v.includes('\n'))
            return considerHttps()
        // v is a path
        httpsOptions[k] = ''
        unwatch = watchLoad(v, data => {
            httpsOptions[k] = data
            considerHttps()
        }, { immediateFirst: true }).unwatch
        await considerHttps()
    })
}

const PORT_DISABLED = -1
export const httpsPortCfg = defineConfig('https_port', PORT_DISABLED)
httpsPortCfg.sub(considerHttps)
listenInterface.sub(considerHttps)

interface StartServer { port: number, host?:string }
export function startServer(srv: typeof httpSrv, { port, host }: StartServer) {
    return new Promise<number>(async resolve => {
        if (!srv) return 0
        try {
            if (port === PORT_DISABLED || !host && !await testIpV4()) // !host means ipV4+6, and if v4 port alone is busy we won't be notified of the failure, so we'll first test it on its own
                return resolve(0)
            // from a few tests, this seems enough to support the expect-100 http/1.1 mechanism, at least with curl -T, not used by chrome|firefox anyway
            srv.on('checkContinue', (req, res) => srv.emit('request', req, res))
            port = await listen(host)
            if (port)
                console.log(srv.name, "serving on", host||"any network", ':', port)
            resolve(port)
        }
        catch(e) {
            srv.error = String(e)
            console.error(srv.name, "couldn't listen on port", port, srv.error)
            resolve(0)
        }
    })

    async function testIpV4() {
        const res = await listen('0.0.0.0')
        await new Promise(res => srv?.close(res))
        return res > 0
    }

    function listen(host?: string) {
        return new Promise<number>(async (resolve, reject) => {
            srv?.on('error', onError).listen({ port, host }, () => {
                const ad = srv.address()
                if (!ad)
                    return reject('no address')
                if (typeof ad === 'string') {
                    srv.close()
                    return reject('type of socket not supported')
                }
                srv.removeListener('error', onError) // necessary in case someone calls stop/start many times
                resolve(ad.port)
            })

             async function onError(e?: Error) {
                if (!srv) return
                srv.error = String(e)
                srv.busy = undefined
                const { code } = e as any
                if (code === 'EACCES' && port < 1024)
                    srv.error = `lacking permission on port ${port}, try with permission (${IS_WINDOWS ? 'administrator' : 'sudo'}) or port > 1024`
                if (code === 'EADDRINUSE') {
                    srv.busy = findProcess('port', port).then(res => res?.[0]?.name || '', () => '')
                    srv.error = `port ${port} busy: ${await srv.busy || "unknown process"}`
                }
                console.error(srv.name, srv.error)
                const k = (srv === httpSrv? portCfg : httpsPortCfg).key()
                console.log(` >> try specifying a different port, enter this command: config ${k} 1080`)
                resolve(0)
            }
        })
    }
}

export function stopServer(srv?: http.Server) {
    return new Promise(resolve => {
        if (!srv?.listening)
            return resolve(null)
        const ad = srv.address()
        if (ad && typeof ad !== 'string')
            console.log("stopped port", ad.port)
        srv.close(err => {
            if (err && (err as any).code !== 'ERR_SERVER_NOT_RUNNING')
                console.debug("failed to stop server", String(err))
            resolve(err)
        })
    })
}

function getCurrentPort(srv: typeof httpSrv) {
    return (srv?.address() as any)?.port as number | undefined
}

export async function getServerStatus(includeSrv=true) {
    return {
        http: await serverStatus(httpSrv, portCfg.get()),
        https: await serverStatus(httpsSrv, httpsPortCfg.get()),
    }

    async function serverStatus(srv: typeof httpSrv, configuredPort: number) {
        const busy = await srv?.busy
        await wait(0) // simple trick to wait for also .error to be updated. If this trickery becomes necessary elsewhere, then we should make also error a Promise.
        return {
            ..._.pick(srv, ['listening', 'error']),
            busy,
            port: getCurrentPort(srv) || configuredPort,
            configuredPort,
            srv: includeSrv ? srv : undefined,
        }
    }}

const ignore = /^(lo|.*loopback.*|virtualbox.*|.*\(wsl\).*|llw\d|awdl\d|utun\d|anpi\d)$/i // avoid giving too much information

export async function getIps(external=true) {
    const ips = onlyTruthy(Object.entries(networkInterfaces()).map(([name, nets]) =>
        nets && !ignore.test(name)
        && v4first(onlyTruthy(nets.map(net => !net.internal && net.address)))[0] // for each interface we consider only 1 address
    )).flat()
    const e = external && defaultBaseUrl.externalIp
    if (e && !ips.includes(e))
        ips.unshift(e)
    const ret = v4first(ips)
        .filter((x,i,a) => a.length > 1 || !x.startsWith('169.254')) // 169.254 = dhcp failure on the interface, but keep it if it's our only one
    defaultBaseUrl.localIp = ret[0] || ''
    return ret

    function v4first(a: string[]) {
        return _.sortBy(a, isIPv6) // works because `false` comes first
    }
}

export async function getUrls() {
    const on = listenInterface.get()
    const ips = on ? [on] : await getIps()
    return Object.fromEntries(onlyTruthy([httpSrv, httpsSrv].map(srv => {
        if (!srv?.listening)
            return false
        const port = (srv?.address() as any)?.port
        const appendPort = port === (srv.name === 'https' ? 443 : 80) ? '' : ':' + port
        const urls = ips.map(ip => `${srv.name}://${ipForUrl(ip)}${appendPort}`)
        return urls.length && [srv.name, urls]
    })))
}

function printUrls(srvName: string) {
    getUrls().then(urls =>
        _.each(urls[srvName], url =>
            console.log('serving on', url)))
}
