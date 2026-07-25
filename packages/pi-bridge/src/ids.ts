export function id(prefix: string) {
  const rand = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

export function projectIdForDirectory(directory: string) {
  let hash = 0
  for (let i = 0; i < directory.length; i++) hash = (hash * 31 + directory.charCodeAt(i)) >>> 0
  return hash.toString(16).padStart(16, "0")
}
