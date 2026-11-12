# Inner Circle — personal preset for review

[Inner Circle](https://github.com/PetarKing/hermes-inner-circle) is my personal,
bot-centric Hermes Desktop setup, heavily inspired by Grok Bot. It puts bots
and conversations first, hides session clutter reversibly, and uses a sage
palette with large portraits. Shared as-is in case it is useful to others.

![Portrait sidebar and readable sample chat](https://raw.githubusercontent.com/PetarKing/hermes-inner-circle/main/demo/gallery.jpg)

[Video](https://github.com/PetarKing/hermes-inner-circle/blob/main/demo/showcase.mp4) · [Folders](https://raw.githubusercontent.com/PetarKing/hermes-inner-circle/main/demo/folders.jpg) · [Folded activity](https://raw.githubusercontent.com/PetarKing/hermes-inner-circle/main/demo/activity.jpg)

The complete opt-in package combines the portrait/compact roster, native folders,
ordering, advancing ages, unread cues, chat/header/composer polish, quiet work
display, collapsed Task Dock and evidence-driven activity/channel renderers.
It reuses selected MIT-licensed Bubble Mode and Task Dock code with attribution.
Native folders replace the older Bot Sections layer for the targeted Hermes.
Computer viewer and texting-style remain optional upstream products.

```sh
hermes plugins install PetarKing/hermes-inner-circle --enable
```

Then enable Inner Circle in Desktop and apply its sage theme. It replaces
standalone Bubble Mode/Task Dock for this preset; do not enable duplicate copies.
The kit's existing installer and defaults are unchanged.

This contribution is an invitation to review the implementation and consider
folding in the whole optional preset, selected ideas or compatibility work if it
fits Bot Kit. There is no expectation to merge this design or change defaults.
The implementation, checks, install/undo guide and integration contract live in
one maintained repository, rather than a second stale copy in this folder.

Telegram sync, Conduit calls/transcripts, personal identities and private routing
are not included. Generic channel/activity display hooks are; adapters can supply
their own verified metadata. Missing evidence leaves native messages unchanged.

The repository welcomes ideas and adaptation questions, with no support or fix
commitment. The code is experimental: stock native GUI/cross-platform acceptance
is still distinct from isolated package/browser checks. Hermes's catalog also
currently forbids its native DOM approach; SDK hooks would be needed for listing.
See the [source and current verification](https://github.com/PetarKing/hermes-inner-circle/blob/main/docs/DEVELOPMENT.md).
