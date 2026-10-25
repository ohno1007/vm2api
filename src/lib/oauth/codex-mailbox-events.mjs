const failures = new Map()
const key = (root, id) => `${root}\0${id}`

export function recordMailboxAuthFailure(root, id) {
  if (failures.size > 256) failures.delete(failures.keys().next().value)
  failures.set(key(root, id), Date.now())
}

export function mailboxAuthFailure(root, id) {
  const at = failures.get(key(root, id))
  return at && Date.now() - at < 30 * 60_000 ? at : null
}

export function clearMailboxAuthFailure(root, id) {
  failures.delete(key(root, id))
}
