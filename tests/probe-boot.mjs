/** 一次性探针：验证运行中 DSH 的引导图已枚举 dsh-agents 且能分发 client.js。 */
import http from 'node:http'

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 3080, path }, (r) => {
      let d = ''
      r.on('data', (c) => { d += c })
      r.on('end', () => resolve({ status: r.statusCode, body: d }))
    }).on('error', reject)
  })
}

const root = await get('/')
const marker = '"id":"dsh-agents"'
console.log('[1] GET / ->', root.status, '| boot graph contains dsh-agents:', root.body.includes(marker))
const m = root.body.match(/\{"id":"dsh-agents"[^\}]*\}/)
console.log('    entry:', m ? m[0] : '(none)')

const client = await get('/plugins/dsh-agents/client.js?rev=probe')
console.log('[2] GET /plugins/dsh-agents/client.js ->', client.status, '| bytes=' + client.body.length)
console.log('    head:', JSON.stringify(client.body.slice(0, 90)))
