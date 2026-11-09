// Preview / render-test data: a roster and an open chat in every state the
// transcript draws (dividers, both bubbles, tools, thinking, approval, activity).
// Everything here is invented demo content.

const day = new Date(2026, 10, 8, 19, 15).getTime()

export const ROSTER = [
  { name: 'travel', display_name: 'Travel', connectionId: 'local', connectionKind: 'local', sourceScoped: true, route: { connectionId: 'local', mode: 'local', profile: 'travel', targetProfile: 'travel' }, canonical_session: { id: 's-root', preview: 'I’ll look for a quiet cabin near the lake.', last_active: day / 1000 + 7400 } },
  { name: 'scholar', display_name: 'Scholar', remoteSource: true, sourceScoped: true, connectionId: 'home-server', connectionKind: 'ssh', connectionLabel: 'HOME-SERVER', route: { connectionId: 'home-server', mode: 'remote', profile: 'scholar', targetProfile: 'scholar' }, canonical_session: { id: 'k-root', preview: 'I added two picks to your reading list.', last_active: day / 1000 - 86400 } },
  { name: 'budget', display_name: 'Budget', connectionId: 'local', connectionKind: 'local', sourceScoped: true, route: { connectionId: 'local', mode: 'local', profile: 'budget', targetProfile: 'budget' }, last_session: { preview: 'Weekly summary is ready: you’re under budget.', last_active: day / 1000 - 3 * 86400 } },
  { name: 'planner', display_name: 'Planner', remoteSource: true, sourceScoped: true, connectionId: 'home-server', connectionKind: 'ssh', connectionLabel: 'HOME-SERVER', sourceReachable: false, route: { connectionId: 'home-server', mode: 'remote', profile: 'planner', targetProfile: 'planner' } },
  // A pink bot (Hermes's hsl() profile colour) and a light yellow one.
  { name: 'recipes', display_name: 'Recipes', connectionId: 'local', connectionKind: 'local', sourceScoped: true, ui_meta: { 'hermes-bots': { color: 'hsl(330 68% 58%)' } }, route: { connectionId: 'local', mode: 'local', profile: 'recipes', targetProfile: 'recipes' }, canonical_session: { id: 'o-root', preview: 'Saved. It’s on tonight’s plan with the link.', last_active: day / 1000 + 3600 } },
  { name: 'sunny', display_name: 'Sunny', connectionId: 'local', connectionKind: 'local', sourceScoped: true, ui_meta: { 'hermes-bots': { color: '#facc15' } }, route: { connectionId: 'local', mode: 'local', profile: 'sunny', targetProfile: 'sunny' }, canonical_session: { id: 'y-root', preview: 'Sunny all weekend, highs around 24°C.', last_active: day / 1000 - 7200 } }
]

export const CHAT_ITEMS = [
  { kind: 'user', id: 'u1', text: 'Can you find a cabin near the lake for next weekend?', at: day },
  { kind: 'assistant', id: 'a1', text: 'I found three cabins within an hour of the lake. Two have free cancellation, and one has a hot tub. Want me to check your trip folder for the dates?', at: day + 60_000, reasoning: 'Compare price, distance and cancellation terms. Check the saved trip notes next.' },
  { kind: 'tools', id: 't1', at: day + 70_000, tools: [ { id: 'c1', name: 'web_search', label: 'Searching cabin listings', status: 'done', duration: 2.4 }, { id: 'c2', name: 'read_file', label: 'Reading trip-notes.md', status: 'done' } ] },
  { kind: 'approval', id: 'approval:req-1', requestId: 'req-1', status: 'pending', command: 'ls ~/Documents/trip', description: 'List the files in your trip folder without changing anything', choices: ['once', 'session', 'always', 'deny'], at: day + 80_000 },
  { kind: 'user', id: 'u2', text: 'Yes, go ahead', at: day + 2 * 3_600_000 },
  { kind: 'tools', id: 't2', at: day + 2 * 3_600_000 + 5_000, tools: [ { id: 'c3', name: 'terminal', label: 'Listing the trip folder', status: 'running' } ] }
]

const night = new Date(2026, 10, 8, 21, 12).getTime()

/** Short bot replies beside user bubbles, then a run of consecutive bot
 *  messages and one with markdown (heading, bullets, inline code, a link). */
export const SHORT_ITEMS = [
  { kind: 'user', id: 's-u1', text: 'morning!', at: night - 2 * 86_400_000 },
  { kind: 'assistant', id: 's-a1', text: 'Morning.', reasoning: 'A quick hello.', at: night - 2 * 86_400_000 + 30_000 },
  { kind: 'user', id: 's-u2', text: 'anything new for me?', at: night },
  { kind: 'assistant', id: 's-a2', text: 'A couple of things 📚', at: night + 20_000 },
  { kind: 'user', id: 's-u3', text: 'thanks', at: night + 4 * 3_600_000 },
  { kind: 'assistant', id: 's-a3', text: 'Anytime!', at: night + 4 * 3_600_000 + 10_000 },
  { kind: 'user', id: 's-u4', text: 'what should I read next?', at: night + 4 * 3_600_000 + 60_000 },
  { kind: 'assistant', id: 's-a4', text: 'You just finished an essay collection, so a short novel would be a nice change of pace.', at: night + 4 * 3_600_000 + 70_000 },
  { kind: 'assistant', id: 's-a5', text: 'I added two picks to your reading list.', at: night + 4 * 3_600_000 + 75_000 },
  { kind: 'assistant', id: 's-a6', text: '## Reading list\n\n- a short mystery novel\n- a beginner’s guide to birdwatching\n\nBoth are saved in `reading-list.md`. More ideas are on [the shelf page](https://example.com/shelf).', at: night + 4 * 3_600_000 + 80_000 }
]

/** A chat with your messages in it (the pink and yellow bots' pages), with a
 *  link and inline code in one of them. */
export const USER_ITEMS = [
  { kind: 'assistant', id: 'p-a1', text: 'Your meal plan for the week is ready: five dinners, all under 30 minutes.', at: night - 86_400_000 },
  { kind: 'user', id: 'p-u1', text: 'what’s for dinner tonight?', at: night },
  { kind: 'assistant', id: 'p-a2', text: 'Let me check your pantry list.', reasoning: 'Look at the pantry list.', at: night + 20_000 },
  { kind: 'tools', id: 'p-t1', at: night + 25_000, tools: [ { id: 'p-c1', name: 'read_file', label: 'Reading pantry.md', status: 'done', duration: 1.2 } ] },
  { kind: 'assistant', id: 'p-a3', text: 'You have pasta, tomatoes and basil, so a quick tomato pasta would work.', at: night + 40_000 },
  { kind: 'user', id: 'p-u2', text: 'sounds good!', at: night + 3_600_000 },
  { kind: 'user', id: 'p-u3', text: 'save it to `recipes/pasta.md` and add https://example.com/pasta too', at: night + 3_660_000 },
  { kind: 'assistant', id: 'p-a4', text: 'Saved. It’s on tonight’s plan with the link.', at: night + 3_700_000 }
]

const morning = new Date(2026, 10, 9, 12, 46).getTime()

/** A chat shaped like the reference screenshot: a short exchange, then long
 *  bot replies with a heading, bullets and links. */
export const MD_ITEMS = [
  { kind: 'user', id: 'm-u1', text: 'Hello!', at: morning },
  { kind: 'assistant', id: 'm-a1', text: 'Hi there 👋', at: morning + 10_000 },
  { kind: 'user', id: 'm-u2', text: 'can you sum up what I saved this week?', at: morning + 60_000 },
  { kind: 'assistant', id: 'm-a2', text: 'Sure. You saved six articles and two books this week. Here are the highlights.', at: morning + 70_000 },
  { kind: 'assistant', id: 'm-a3', text: 'Here’s your weekly reading digest.\n\n**This week**\n\n- A long read on how city parks shape the neighbourhoods around them. [Article](https://example.com/parks) · [Notes](https://example.com/notes)\n- A short guide to keeping a reading journal, with a template you can copy. [Guide](https://example.com/journal) · [Template](https://example.com/template)\n\nNothing new from the authors you follow.', at: morning + 80_000 },
  { kind: 'user', id: 'm-u3', text: 'nice, can you send this every morning?', at: morning + 3 * 60_000 },
  { kind: 'assistant', id: 'm-a4', text: 'Done: a “Morning reading digest” now runs at 8:00 AM. You can pause it from the profile panel.', at: morning + 3 * 60_000 + 15_000 }
]
