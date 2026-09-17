/** 探针：看设置卡端点的 catalog 字段实际内容。 */
import http from 'node:http'

http.get({ host: '127.0.0.1', port: 3080, path: '/plugins/dsh-agents/config' }, (r) => {
  let d = ''
  r.on('data', (c) => { d += c })
  r.on('end', () => {
    console.log('status', r.statusCode)
    try {
      const body = JSON.parse(d)
      const keys = Object.keys(body.catalog ?? {})
      console.log('catalog provider keys:', keys.length, '->', keys.slice(0, 20).join(', '))
      const first = keys[0]
      if (first) console.log('sample', first, '=> models:', (body.catalog[first] ?? []).slice(0, 8))
    } catch (e) { console.log('parse fail', e.message, d.slice(0, 200)) }
  })
}).on('error', (e) => console.error('ERR', e.message))
