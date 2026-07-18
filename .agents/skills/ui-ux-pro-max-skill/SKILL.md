---
name: ui-ux-pro-max
description: "UI/UX design intelligence for web and mobile. Includes 50+ styles, 161 color palettes, 57 font pairings, 161 product types, 99 UX guidelines, and 25 chart types. Actions: plan, build, create, design, implement, review, fix, improve, optimize, enhance, refactor, and check UI/UX code. Topics: color systems, accessibility, animation, layout, typography, font pairing, spacing, interaction states, shadow, and gradient."
---

# UI/UX Pro Max - Design Intelligence

Comprehensive design guide for web and mobile applications. Contains 50+ styles, 161 color palettes, 57 font pairings, 161 product types with reasoning rules, 99 UX guidelines, and 25 chart types.

## Rule Categories by Priority

| Priority | Category | Impact | Domain | Key Checks (Must Have) | Anti-Patterns (Avoid) |
|----------|----------|--------|--------|------------------------|------------------------|
| 1 | Accessibility | CRITICAL | `ux` | Contrast 4.5:1, Alt text, Keyboard nav, Aria-labels | Removing focus rings, Icon-only buttons without labels |
| 2 | Touch & Interaction | CRITICAL | `ux` | Min size 44×44px, 8px+ spacing, Loading feedback | Reliance on hover only, Instant state changes (0ms) |
| 3 | Performance | HIGH | `ux` | WebP/AVIF, Lazy loading, Reserve space (CLS < 0.1) | Layout thrashing, Cumulative Layout Shift |
| 4 | Style Selection | HIGH | `style`, `product` | Match product type, Consistency, SVG icons (no emoji) | Mixing flat & skeuomorphic randomly, Emoji as icons |
| 5 | Layout & Responsive | HIGH | `ux` | Mobile-first breakpoints, Viewport meta, No horizontal scroll | Horizontal scroll, Fixed px container widths, Disable zoom |
| 6 | Typography & Color | MEDIUM | `typography`, `color` | Base 16px, Line-height 1.5, Semantic color tokens | Text < 12px body, Gray-on-gray, Raw hex in components |
| 7 | Animation | MEDIUM | `ux` | Duration 150–300ms, Motion conveys meaning, Spatial continuity | Decorative-only animation, Animating width/height, No reduced-motion |
| 8 | Forms & Feedback | MEDIUM | `ux` | Visible labels, Error near field, Helper text, Progressive disclosure | Placeholder-only label, Errors only at top, Overwhelm upfront |
| 9 | Navigation Patterns | HIGH | `ux` | Predictable back, Bottom nav ≤5, Deep linking | Overloaded nav, Broken back behavior, No deep links |
| 10 | Charts & Data | LOW | `chart` | Legends, Tooltips, Accessible colors | Relying on color alone to convey meaning |

---

## Detailed Guidelines

### 1. Accessibility (CRITICAL)
- **Contrast**: Minimum 4.5:1 ratio for normal text (large text 3:1).
- **Focus Rings**: Active interactive elements must show clear 2-4px outline focus rings.
- **Aria-Labels**: Provide descriptive labels for icon-only components.
- **Dynamic Font**: Support text scaling without clipping.
- **Reduced Motion**: Respect system preferences (`prefers-reduced-motion`).

### 2. Style Selection & Aesthetics (HIGH)
- **AI-Design Cleanup**: Avoid generic layouts. Replace simple boxed cards with layered container systems, dynamic grid proportions, and subtle elevation changes.
- **Color Systems**: Use semantic slate colors for light modes (`#0f172a` / `#f8fafc`) and subtle blue/cyan tokens to convey data hierarchy.
- **SVG Icons**: Utilize professional vector SVG symbols (e.g. Element Plus or Lucide) instead of plain text or emoji overlays.
- **Grid Layout**: Implement asymmetrical grid splits (e.g. 1.35fr/0.65fr) instead of simple equal columns to highlight primary information.

### 3. Layout & Spacing
- **Spacing Scale**: Implement a strict 4px/8px incremental padding/margin scale (`var(--space-*)`).
- **Cards**: Add custom visual separation, thin border gradients, and hover scale transitions (`translateY(-4px)` with spring-like bezier curves).
- **Glassmorphism**: Combine translucent backgrounds, fine borders (`rgba(22, 119, 255, 0.08)`), drop-shadows, and `backdrop-filter: blur(20px)` to design premium cards.

### 4. Typography & Fonts
- **Font Pairing**: Use elegant sans-serif (Inter, Montserrat) for headings, combined with clean body text.
- **Weight hierarchy**: Headings `font-weight: 800 - 900` to draw attention, descriptions `font-weight: 400`, data counts `font-weight: 700`.

### 5. Forms & Tables
- **Table Cleanup**: Strip standard table borders. Style table headers with low-contrast, light blue/slate highlights. Hover states must be soft (`rgba(22, 119, 255, 0.04)`).
- **Transitions**: Smooth state changes for hover/active/expanded states using cubic-bezier curves (e.g. `cubic-bezier(0.25, 0.8, 0.25, 1)`).
