/** Reads an `--ink-*` CSS variable (set per-theme in index.css) as an
 * opacity-aware color, so every existing `bg-ink-950`, `text-ink-50/60`, etc.
 * utility automatically works in both light and dark mode with no per-file
 * changes. */
function themedColor(variable) {
  return ({ opacityValue }) =>
    opacityValue === undefined ? `rgb(var(${variable}))` : `rgb(var(${variable}) / ${opacityValue})`;
}

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Base: blue-undertoned graphite. Reads as an instrument panel rather
        // than a neutral-gray admin template, and holds up over a long shift.
        // Values live in CSS variables (see index.css) so the same token
        // names serve both light and dark themes.
        ink: {
          950: themedColor('--ink-950'),
          900: themedColor('--ink-900'),
          850: themedColor('--ink-850'),
          800: themedColor('--ink-800'),
          700: themedColor('--ink-700'),
          600: themedColor('--ink-600'),
          500: themedColor('--ink-500'),
          400: themedColor('--ink-400'),
          300: themedColor('--ink-300'),
          200: themedColor('--ink-200'),
          100: themedColor('--ink-100'),
          50: themedColor('--ink-50'),
        },
        // Signal colours encode task state; they are never decorative.
        signal: {
          amber: '#E8A33D',   // waiting on someone
          cyan: '#3DA5C4',    // in flight
          green: '#4A9E6F',   // settled
          red: '#C4553D',     // failed or rejected
          slate: '#6B7A93',   // inert or terminal-neutral
        },
        // Reserved exclusively for simulated payout data. Nothing else may
        // use it, so the marker stays unambiguous wherever it appears.
        sim: {
          DEFAULT: '#8B7BD8',
          dim: '#5B4FA0',
          wash: '#1E1B33',
          // Fixed (never theme-routed) light text color for content placed on
          // `sim-wash` — that background is intentionally the same dark violet
          // in both light and dark mode, so text on it must also be fixed
          // rather than a theme-following `ink-*` token, which would go dark
          // (and unreadable) in light mode.
          fg: '#E7E4F7',
        },
        // Brand accent for marketing-style surfaces (auth screen, empty
        // states) — kept separate from `signal`, which is reserved for task
        // state and must never be decorative.
        brand: {
          50: '#EEF1FF',
          100: '#DFE4FF',
          400: '#5B6EF5',
          500: '#3B4FE8',
          600: '#2E3FD1',
          700: '#2532A8',
          900: '#161C5C',
        },
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.04em' }],
      },
      borderRadius: { panel: '14px' },
      boxShadow: {
        panel: '0 1px 2px rgba(8,12,20,0.16), 0 10px 28px -12px rgba(8,12,20,0.38)',
        rail: 'inset 2px 0 0 0 currentColor',
      },
      keyframes: {
        'pulse-dot': { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.35' } },
        'slide-up': { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: {
        'pulse-dot': 'pulse-dot 2s ease-in-out infinite',
        'slide-up': 'slide-up 180ms ease-out',
      },
    },
  },
  plugins: [],
};
