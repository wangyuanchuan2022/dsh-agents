/** 探针：确认宿主分发的 client.js 是否已是下拉版（无需重启的浏览器半热分发验证）。 */
import http from 'node:http'

http.get({ host: '127.0.0.1', port: 3080, path: '/plugins/dsh-agents/client.js?rev=check2' }, (r) => {
  let d = ''
  r.on('data', (c) => { d += c })
  r.on('end', () => {
    console.log('status', r.statusCode, 'bytes', d.length)
    console.log('has select dropdown:', d.includes("createElement('select'"))
    console.log('uses catalog:', d.includes('catalog'))
  })
}).on('error', (e) => console.error('ERR', e.message))
