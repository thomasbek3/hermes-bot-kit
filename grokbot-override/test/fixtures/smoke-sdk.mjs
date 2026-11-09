// The SDK's UI parts for the loader-faithful tests (test/loader-boot.mjs
// `primitives: true`). Names mirror what @hermes/plugin-sdk exports at Hermes
// 2bd378ed1b (apps/desktop/src/sdk/index.ts:1700-1740): the Radix Dialog /
// ContextMenu / DropdownMenu parts (no DropdownMenuSub: the SDK does not
// export it), ToolsetConfigPanel and the status-bar areas. Built on the React
// the plugin itself runs on (the loader's), never a second copy.
//
// Menus render their content in place (a server or DOM render shows every
// entry) and an item click fires `onSelect`, as Radix does; dialogs render
// when open. Without these parts (an older Desktop) the override uses its own
// fallbacks (inline menus, an in-place modal).

export const PRIMITIVES = [
  'Dialog',
  'DialogContent',
  'DialogTitle',
  'DialogDescription',
  'DialogHeader',
  'DialogFooter',
  'DialogTrigger',
  'ContextMenu',
  'ContextMenuTrigger',
  'ContextMenuContent',
  'ContextMenuItem',
  'ContextMenuCheckboxItem',
  'ContextMenuSeparator',
  'ContextMenuSub',
  'ContextMenuSubTrigger',
  'ContextMenuSubContent',
  'DropdownMenu',
  'DropdownMenuTrigger',
  'DropdownMenuContent',
  'DropdownMenuItem',
  'DropdownMenuSeparator'
]

/** Parts every SDK build has (with or without the Radix primitives). */
export function sdkExtras(React) {
  const h = React.createElement
  return {
    STATUSBAR_AREAS: { left: 'statusBar.left', right: 'statusBar.right' },
    ToolsetConfigPanel: ({ toolset, profile }) => h('div', { 'data-toolset': toolset, 'data-scope': JSON.stringify(profile) }, 'toolset config'),
    resolveSiblingWsUrl: async (_scope, path) => `wss://example.invalid${path}`
  }
}

/** The Radix dialog / menu parts. */
export function sdkPrimitives(React) {
  const h = React.createElement
  const pass = name => {
    const C = ({ children }) => h(React.Fragment, null, children)
    C.displayName = name
    return C
  }
  const strip = props => {
    const { asChild, onSelect, onOpenChange, bodyClassName, showCloseButton, align, open, ...rest } = props || {}
    return rest
  }
  const item = ({ children, disabled, onSelect, ...props }) =>
    h(
      'div',
      {
        role: 'menuitem',
        'aria-disabled': disabled || undefined,
        onClick: disabled ? undefined : () => onSelect?.({ preventDefault() {} }),
        ...strip(props)
      },
      children
    )
  return {
    Dialog: ({ open, children }) => (open ? h(React.Fragment, null, children) : null),
    DialogContent: ({ children, ...props }) => h('div', { role: 'dialog', ...strip(props) }, children),
    DialogTitle: ({ children, ...props }) => h('h2', strip(props), children),
    DialogDescription: ({ children, ...props }) => h('p', strip(props), children),
    DialogHeader: ({ children }) => h('div', null, children),
    DialogFooter: ({ children }) => h('div', null, children),
    DialogTrigger: pass('DialogTrigger'),
    ContextMenu: pass('ContextMenu'),
    ContextMenuTrigger: ({ children }) => children,
    ContextMenuContent: ({ children, ...props }) => h('div', { role: 'menu', 'data-menu': 'context', ...strip(props) }, children),
    ContextMenuItem: item,
    ContextMenuCheckboxItem: item,
    ContextMenuSeparator: props => h('hr', strip(props)),
    ContextMenuSub: pass('ContextMenuSub'),
    ContextMenuSubTrigger: ({ children, ...props }) => h('div', { role: 'menuitem', ...strip(props) }, children),
    ContextMenuSubContent: ({ children, ...props }) => h('div', { role: 'menu', ...strip(props) }, children),
    DropdownMenu: pass('DropdownMenu'),
    DropdownMenuTrigger: ({ children }) => children,
    DropdownMenuContent: ({ children, ...props }) => h('div', { role: 'menu', 'data-menu': 'dropdown', ...strip(props) }, children),
    DropdownMenuItem: item,
    DropdownMenuSeparator: props => h('hr', strip(props))
  }
}
