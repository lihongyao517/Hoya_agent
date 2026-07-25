type Listener = (event: GlobalEvent) => void

export type GlobalEvent = {
  directory: string
  project?: string
  workspace?: string
  payload: {
    id: string
    type: string
    properties: Record<string, unknown>
  }
}

const listeners = new Set<Listener>()
let seq = 0

export function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emit(directory: string, type: string, properties: Record<string, unknown> = {}) {
  const event: GlobalEvent = {
    directory,
    payload: {
      id: `evt_${++seq}`,
      type,
      properties,
    },
  }
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (error) {
      console.error("[pi-bridge] event listener error", error)
    }
  }
}

export function connectedEvent() {
  return {
    directory: "",
    payload: {
      id: `evt_${++seq}`,
      type: "server.connected",
      properties: {},
    },
  } satisfies GlobalEvent
}
