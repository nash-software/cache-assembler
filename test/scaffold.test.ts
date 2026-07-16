import { describe, expect, it } from 'vitest'
import { assemble } from '../src/index.js'

describe('scaffold', () => {
  it('index exports an assemble function', () => {
    expect(typeof assemble).toBe('function')
  })
})
