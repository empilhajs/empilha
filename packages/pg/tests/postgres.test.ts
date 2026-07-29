import { describe, expect, test } from "bun:test"
import { postgres } from "../src"

describe("@empilha/pg", () => {
  test("cria o pool e encaminha configuração ao Empilha", async () => {
    let received:
      | {
          pool: {
            options: { connectionString?: string; max?: number }
            end: () => Promise<void>
          }
          options: {
            sql?: string
            timeout?: number | null
            healthCheck?: string | false
          }
        }
      | undefined

    const plugin = postgres({
      url: "postgres://localhost/empilha",
      max: 4,
      sql: "./queries",
      timeout: 2500,
      healthCheck: "postgres",
    })

    plugin.install({
      postgres(pool, options) {
        received = { pool, options }
      },
    } as never)

    expect(received?.pool.options.connectionString).toBe(
      "postgres://localhost/empilha",
    )
    expect(received?.pool.options.max).toBe(4)
    expect(received?.options).toEqual({
      sql: "./queries",
      timeout: 2500,
      healthCheck: "postgres",
    })

    await received?.pool.end()
  })

  test("preserva healthCheck false e os defaults do pool", async () => {
    let received: { options: { healthCheck?: string | false } } | undefined
    const plugin = postgres({
      url: "postgres://localhost/empilha",
      healthCheck: false,
    })

    plugin.install({
      postgres(_pool, options) {
        received = { options }
      },
    } as never)

    expect(received?.options).toEqual({
      sql: undefined,
      timeout: undefined,
      healthCheck: false,
    })
  })
})
