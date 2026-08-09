// The single source of truth for which accent palettes an organization may
// wear. No other module may hardcode a theme slug -- import from here.
//
// WHY A CLOSED SET RATHER THAN A COLOR VALUE
//
// The chosen value ends up driving CSS custom properties on every member's
// screen. Storing a hex (or worse, a full gradient string) would mean a tenant
// owner's input reaches a stylesheet, which is a styling-injection surface --
// and a defacement vector against their own members. A slug from this list
// can only ever select a palette the frontend already ships, hand-authored
// and contrast-checked.
//
// It also keeps the palettes editable: refining a gradient is a CSS change in
// elle_f/src/styles/tokens.css, not a migration over stored hex values.
//
// KEEPING THIS IN STEP WITH THE FRONTEND
//
// These slugs are mirrored by ORGANIZATION_THEMES in
// elle_f/src/lib/orgThemes.js, which holds the actual colors. The server does
// not know or care what 'coral' looks like -- only that it is a name it
// agreed to store. A slug present here but missing there would render as the
// default palette rather than breaking, since the client falls back on an
// unknown name.
const ORGANIZATION_THEMES = Object.freeze([
  'lime', // the original tokens.css accent -- the default, see migration 0029
  'violet',
  'ocean',
  'coral',
  'amber',
  'forest'
]);

const DEFAULT_ORGANIZATION_THEME = 'lime';

module.exports = { ORGANIZATION_THEMES, DEFAULT_ORGANIZATION_THEME };
