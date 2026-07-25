import { listen } from "./server"

const port = Number(process.env.PORT || process.env.HOYA_BRIDGE_PORT || 4096)
const password = process.env.OPENCODE_SERVER_PASSWORD || process.env.HOYA_BRIDGE_PASSWORD || ""

await listen({
  port,
  hostname: process.env.HOST || "127.0.0.1",
  username: "opencode",
  password,
})
