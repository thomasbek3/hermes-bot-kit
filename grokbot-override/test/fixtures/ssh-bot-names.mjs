// Rows for the SSH bot-name loader tests (test/loader-ssh-bot-names*.test.mjs).

export const LOCAL_DEFAULT = {
  name: 'default',
  connectionId: 'local',
  connectionKind: 'local',
  sourceScoped: true,
  route: { connectionId: 'local', mode: 'local', profile: 'default', targetProfile: 'default' },
  canonical_session: { id: 'l-root', preview: 'local preview', last_active: 1762560000 }
}
export const SSH_DEFAULT = {
  name: 'default',
  remoteSource: true,
  sourceScoped: true,
  connectionId: 'laptop',
  connectionKind: 'ssh',
  connectionLabel: 'Laptop',
  route: { connectionId: 'laptop', mode: 'remote', profile: 'default', targetProfile: 'default' },
  canonical_session: { id: 'r-root', preview: 'remote preview', last_active: 1762550000 }
}
export const SOURCES = [
  { connectionId: 'local', label: 'This Mac', reachable: true },
  { connectionId: 'laptop', label: 'Laptop', reachable: false, error: 'connect-on-demand' }
]

export const rowNames = el => [...el.querySelectorAll('button.gbo-row')].map(b => b.querySelector('.gbo-row-name')?.textContent || '')
