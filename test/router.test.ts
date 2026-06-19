import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker from '../src/index.ts'
import { makeEnv } from './helpers.ts'

const ctx = {} as ExecutionContext

test('routes /api to the index manifest', async () => {
  const res = await worker.fetch(new Request('https://x.test/api'), makeEnv(), ctx)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).name, 'PromptScope API')
})

test('routes /api/analyze GET to the analyze manifest', async () => {
  const res = await worker.fetch(new Request('https://x.test/api/analyze'), makeEnv(), ctx)
  assert.equal((await res.json()).method, 'POST /api/analyze')
})

test('routes /api/license, /api/share, /api/checkout to their handlers', async () => {
  const env = makeEnv()
  assert.equal((await worker.fetch(new Request('https://x.test/api/license'), env, ctx)).status, 200)
  // share GET with no id => 400 from handleShare.
  assert.equal((await worker.fetch(new Request('https://x.test/api/share'), env, ctx)).status, 400)
  // checkout with no configured URL => 503.
  assert.equal((await worker.fetch(new Request('https://x.test/api/checkout'), env, ctx)).status, 503)
})

test('non-API paths fall through to the ASSETS binding', async () => {
  let assetReq: Request | undefined
  const env = makeEnv({
    ASSETS: {
      fetch: async (req: Request) => {
        assetReq = req
        return new Response('<html>landing</html>', { status: 200, headers: { 'content-type': 'text/html' } })
      },
    } as unknown as Fetcher,
  })
  const res = await worker.fetch(new Request('https://x.test/index.html'), env, ctx)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), '<html>landing</html>')
  assert.equal(new URL(assetReq!.url).pathname, '/index.html')
})
