// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { RoleAvatar } from '../../web/src/worker/RoleAvatar.js'

afterEach(() => cleanup())

// `role` here is a domain prop on RoleAvatar (worker role: coder/reviewer/…),
// not an HTML ARIA role attribute. biome's useValidAriaRole misfires on the
// JSX attribute name; suppress per-call where the value is a string literal.

describe('RoleAvatar', () => {
  test.each([
    ['coder', 'code'],
    ['reviewer', 'review'],
    ['tester', 'test'],
    ['custom', 'custom'],
    ['orchestrator', 'crown'],
  ])('role=%s renders its own glyph (data-icon=%s) as an svg', (role, icon) => {
    render(<RoleAvatar role={role as never} />)
    const el = screen.getByTestId('role-avatar')
    // Each role maps to a distinct lucide glyph. Asserting the stable
    // `data-icon` marker (not lucide's churny SVG class names) catches a wrong
    // or duplicated mapping; the <svg> check catches "glyph dropped entirely".
    expect(el.getAttribute('data-icon')).toBe(icon)
    expect(el.querySelector('svg')).not.toBeNull()
    // The old two-letter initials (Co/Re/…) are gone — no text content left.
    expect(el.textContent).toBe('')
  })

  test('data-role attribute reflects role for theming', () => {
    // biome-ignore lint/a11y/useValidAriaRole: domain prop, not HTML role
    render(<RoleAvatar role="coder" />)
    expect(screen.getByTestId('role-avatar').getAttribute('data-role')).toBe('coder')
  })

  test('size prop scales the glyph with the avatar (svg size tracks size prop)', () => {
    // biome-ignore lint/a11y/useValidAriaRole: domain prop, not HTML role
    render(<RoleAvatar role="coder" size={40} />)
    const el = screen.getByTestId('role-avatar')
    expect(el.style.width).toBe('40px')
    expect(el.style.height).toBe('40px')
    // glyph size = round(40 * 0.56) = 22 → lucide renders width/height="22"
    const svg = el.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('22')
    expect(svg?.getAttribute('height')).toBe('22')
  })

  test('default size is 32px — width + height + a proportional 18px glyph', () => {
    // biome-ignore lint/a11y/useValidAriaRole: domain prop, not HTML role
    render(<RoleAvatar role="coder" />)
    const el = screen.getByTestId('role-avatar')
    expect(el.style.width).toBe('32px')
    expect(el.style.height).toBe('32px')
    // glyph size = round(32 * 0.56) = 18
    expect(el.querySelector('svg')?.getAttribute('width')).toBe('18')
  })

  test('background and border are derived from role color (status-blue for coder)', () => {
    // biome-ignore lint/a11y/useValidAriaRole: domain prop, not HTML role
    render(<RoleAvatar role="coder" />)
    const el = screen.getByTestId('role-avatar')
    expect(el.style.color).toBe('var(--status-blue)')
    expect(el.style.background).toContain('var(--status-blue)')
    // border is a shorthand string ("1px solid color-mix(...)"); jsdom doesn't
    // decompose it into borderColor, so assert the raw style attribute.
    expect(el.getAttribute('style') ?? '').toContain('var(--status-blue) 35%')
  })

  test('reviewer uses purple, tester uses orange — palette per spec §4.4', () => {
    // biome-ignore lint/a11y/useValidAriaRole: domain prop, not HTML role
    const { rerender } = render(<RoleAvatar role="reviewer" />)
    expect(screen.getByTestId('role-avatar').style.color).toBe('var(--status-purple)')
    // biome-ignore lint/a11y/useValidAriaRole: domain prop, not HTML role
    rerender(<RoleAvatar role="tester" />)
    expect(screen.getByTestId('role-avatar').style.color).toBe('var(--status-orange)')
  })
})
