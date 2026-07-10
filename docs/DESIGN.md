---
name: Technical Orchestration
colors:
  surface: '#fbf8ff'
  surface-dim: '#dad9e4'
  surface-bright: '#fbf8ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f4f2fe'
  surface-container: '#eeecf8'
  surface-container-high: '#e9e7f3'
  surface-container-highest: '#e3e1ed'
  on-surface: '#1a1b23'
  on-surface-variant: '#4a4453'
  inverse-surface: '#2f3039'
  inverse-on-surface: '#f1effb'
  outline: '#7b7485'
  outline-variant: '#ccc3d6'
  surface-tint: '#713dcc'
  primary: '#420093'
  on-primary: '#ffffff'
  primary-container: '#5b21b6'
  on-primary-container: '#c7aaff'
  inverse-primary: '#d3bbff'
  secondary: '#6b38d4'
  on-secondary: '#ffffff'
  secondary-container: '#8455ef'
  on-secondary-container: '#fffbff'
  tertiary: '#323140'
  on-tertiary: '#ffffff'
  tertiary-container: '#494758'
  on-tertiary-container: '#b9b6ca'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ebddff'
  primary-fixed-dim: '#d3bbff'
  on-primary-fixed: '#250059'
  on-primary-fixed-variant: '#581db3'
  secondary-fixed: '#e9ddff'
  secondary-fixed-dim: '#d0bcff'
  on-secondary-fixed: '#23005c'
  on-secondary-fixed-variant: '#5516be'
  tertiary-fixed: '#e4e0f5'
  tertiary-fixed-dim: '#c7c4d8'
  on-tertiary-fixed: '#1b1a29'
  on-tertiary-fixed-variant: '#464555'
  background: '#fbf8ff'
  on-background: '#1a1b23'
  surface-variant: '#e3e1ed'
typography:
  display-lg:
    fontFamily: Geist
    fontSize: 48px
    fontWeight: '600'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Geist
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: '500'
    lineHeight: 32px
  body-lg:
    fontFamily: Geist
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Geist
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
  code-md:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 4px
  xs: 8px
  sm: 16px
  md: 24px
  lg: 40px
  xl: 64px
  gutter: 20px
  margin: 24px
---

## Brand & Style

This design system is built for the high-stakes environment of AI agent orchestration. The visual language balances extreme technical precision with sophisticated clarity. The goal is to evoke a sense of "controlled intelligence"—the UI should feel like a high-performance instrument rather than a decorative interface. 

The style utilizes **Technical Minimalism**: a focus on high information density, clear hierarchies, and utilitarian beauty. It leverages deep purples to signify power and cognitive depth, while the overall light-mode aesthetic ensures the workspace remains focused and accessible for long periods of intense work.

## Colors

The palette is rooted in a structured hierarchy of purples. 
- **Primary (Deep Violet):** Used for critical actions, active states, and brand-defining markers.
- **Secondary (Vibrant Purple):** Used for highlighting agent status and secondary interactive elements.
- **Background (Soft Lavender):** Replaces traditional neutrals to create a cohesive, branded environment that reduces eye strain.
- **Containers (White):** Pure white is reserved for high-level content areas (cards, modals, panels) to maximize contrast against the lavender backdrop.
- **Accents:** Use a strictly monochromatic grayscale for borders and text to ensure the purple remains meaningful and indicates "system activity."

## Typography

Geist is used exclusively across the system to maintain a cohesive, developer-centric aesthetic. The font's geometric precision and legible numerals are vital for displaying agent logs and orchestration metrics.

Headlines should use tighter letter-spacing and heavier weights to command attention. Body text remains generous in line-height for readability. For technical labels and metadata, utilize uppercase transformations and increased letter spacing to differentiate them from actionable text. On mobile, `display-lg` should scale down to 32px to ensure layout integrity.

## Layout & Spacing

The design system employs a **Fixed-Fluid Hybrid** grid. The primary dashboard uses a 12-column grid for the main content area, with a fixed 240px navigation sidebar. 

The spacing rhythm is strictly mathematical, based on a 4px atomic unit. 
- **Desktop:** 24px margins with 20px gutters. Elements should snap to the grid to emphasize the "orchestration" theme.
- **Tablet:** 16px margins; content reflows to 8 columns.
- **Mobile:** 16px margins; content reflows to a single column stack. 

Layouts should favor vertical stacks for agent logs and horizontal alignment for status dashboards.

## Elevation & Depth

This design system avoids heavy drop shadows in favor of **Tonal Layering** and **Low-Contrast Outlines**.

1.  **Level 0 (Base):** Soft Lavender (`#F5F3FF`) background.
2.  **Level 1 (Surface):** Sharp White (`#FFFFFF`) containers with a 1px border (`#E9E4FF`). 
3.  **Level 2 (Active/Hover):** A subtle, diffused shadow (4px blur, 2% opacity) is used only to indicate interactivity.
4.  **Level 3 (Overlay):** Modals and dropdowns use a crisp 1px border in a slightly darker violet to define boundaries without adding visual bulk.

Depth is communicated through the stacking of pure white containers on the tinted lavender base, creating a "card-on-sheet" metaphor that feels clean and organized.

## Shapes

The shape language is disciplined and subtle. We utilize a **Soft (0.25rem)** rounding for standard components like buttons, inputs, and tags. This "subtle" approach maintains the professional, technical feel of the platform while removing the harshness of sharp 90-degree corners.

- **Standard Elements:** 4px (0.25rem) radius.
- **Cards/Panels:** 8px (0.5rem) radius for a more structural feel.
- **Inner Elements:** When an element is nested (e.g., a button inside a card), reduce the inner radius to maintain visual harmony.

## Components

### Buttons
- **Primary:** Deep Violet background, white text. No gradient.
- **Secondary:** Ghost style with a 1px Violet border and Lavender hover state.
- **Icon Buttons:** Square 1:1 ratio with 4px rounding.

### Input Fields
- **Default:** White background, 1px Gray-Lavender border. On focus, the border transitions to Primary Violet with a 2px outer glow in soft lavender.
- **Technical Inputs:** Use the `code-md` typography style for parameter entries.

### Cards & Containers
- White background, no shadow. 
- Header areas within cards should be separated by a 1px horizontal rule (`#F5F3FF`).

### Status Chips
- Small, uppercase labels with a high-contrast background (e.g., Success = Green tint, Error = Red tint) but always maintaining the system's geometric 4px radius.

### Agent Nodes
- Specific to orchestration: Use a "Header-Body" structure. The header is Primary Violet with white text; the body is white with technical metadata. Connectors should be 2px solid Deep Violet lines.