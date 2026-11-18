// Shared by loader-screen-cold-open / loader-screen-hidden: a fake Bot
// Screen gateway (asleep until display.start is let through) and the viewer
// tab opener.

import { waitFor } from '../loader-boot.mjs'
import { SCOUT } from '../loader-surfaces.mjs'

export const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))
const lease = { holder: 'agent', epoch: 1, since: 0 }

export function fakeScreen() {
  const screen = { running: false, release: null }
  const status = () => ({ supported: true, installed: true, running: screen.running, display: ':20', geometry: '1920x1200', profile_key: 'pk-scout', lease })
  return {
    screen,
    answers: {
      'display.status': () => status(),
      // Held until the test lets it finish, so the waking state can be seen.
      'display.start': () =>
        new Promise(resolve => {
          screen.release = () => {
            screen.running = true
            resolve(status())
          }
        }),
      'display.observe': () => {
        if (!screen.running) throw new Error("this profile's Bot Desktop is not running; call display.start first")
        return { ticket: 't', path: '/api/display/ws', viewer_id: 'v-1', ...status() }
      }
    }
  }
}

/** A writable visibility atom, nanostores-shaped (subscribe fires at once). */
export function visibilityAtom(value) {
  const listeners = new Set()
  return {
    get: () => value,
    set(next) {
      value = next
      for (const fn of [...listeners]) fn(value)
    },
    subscribe(fn) {
      listeners.add(fn)
      fn(value)
      return () => listeners.delete(fn)
    }
  }
}

export async function openScreen(booted) {
  const { workspaces, mount, internals } = booted
  internals.openBotScreen(SCOUT)
  const [, tab] = await waitFor(() => [...workspaces.entries()].find(([id]) => String(id).startsWith('grokbot-override-screen-')), 'the screen tab')
  return mount(tab.render)
}

