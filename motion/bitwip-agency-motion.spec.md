# Motion Spec: bitwip-agency-motion
SOURCE: https://www.bitwip.fr/en | SECTION: home-page | CAPTURED: 2026-11-10 | TRIGGER: load, hover, scroll-scrub, cursor

## 1. What the visitor sees (3 to 6 plain sentences)
The visitor enters a dark, editorial experience with ambient atmospheric depth: soft glowing color orbs gently float and breathe behind typography, overlaid with an ultra-fine film grain texture. Words rise sequentially out of masks on a customized expo-out easing curve. A hero card deck dynamically stacks and, on hover, interactively fans out in isometric 3D space with tactile manual click advance. On desktop, an elastic custom cursor smoothly glides and expands over interactive targets while buttons and links magnetically pull towards the pointer. Cards on the horizontal scenario rail and the "How it works" showcase react to cursor movements with silky 3D perspective tilt and dynamic specular light glares.

## 2. Anatomy
- Wrapper(s): Hero viewport (`relative flex min-h-[100svh]`), pinned horizontal rail (`ScenarioTrack`), cream sheets (`.cream`), accordions.
- Items: Hero card deck (5 cards, rotating with spring dealing physics), 7 scenario cards with live state badges, 4 interactive accordion steps, 3 solvency metric panels.
- Atmospheric layers: Film grain SVG noise filter (`.grain`), dynamic mouse spotlight (`radial-gradient`), 2 floating blurred gradient orbs (`ambient-glow-1`, `ambient-glow-2`).

## 3. States
| Element | Property | Initial | Final | Confidence |
|---|---|---|---|---|
| Split heading words | transform | `translateY(110%)` | `translateY(0)` | measured |
| Split heading words | transition | `1.1s cubic-bezier(0.16, 1, 0.3, 1)` | — | measured |
| Hero card deck (hover) | transform | stacked `translate3d(...)` | fanned `rotate(deg)` + `translate3d(X, Y, 0)` | measured |
| Interactive cards | transform | `perspective(900px)` neutral | `rotateX(deg)` + `rotateY(deg)` + `scale3d(1.02)` | measured |
| Magnetic buttons | transform | `translate3d(0, 0, 0)` | `translate3d(dx * 0.35, dy * 0.35, 0)` | measured |
| Custom cursor dot | transform | `translate3d(X, Y, 0)` | scaled `14px` on hover | measured |
| Custom cursor ring | transform | `translate3d(lerpX, lerpY, 0)` | expanded `58px` on hover | measured |

## 4. Timeline
| # | Target | Property | From | To | Start (s) | Duration (s) | Ease | Stagger | Confidence |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Hero subtitle | translateY, opacity | 28px, 0 | 0, 1 | 0.15 | 1.0 | expo-out | — | measured |
| 2 | Headline words | translateY | 110% | 0% | 0.25 | 1.1 | expo-out | 45ms | measured |
| 3 | Hero deck | scale, rotate | 0, -30deg | 1, 0deg | 0.45 | 1.0 | expo-out | — | measured |
| 4 | Deck dealing | transform, opacity | top card | -45%, -65%, -28deg, 0 | 1.3s loop | 0.7 | expo-out | — | measured |
| 5 | CTAs | translateY, opacity | 28px, 0 | 0, 1 | 0.70 | 1.0 | expo-out | — | measured |
| 6 | Solvency cards | 3D Tilt | 0deg | +/-7deg | interactive | 0.1s / 0.45s | lerp / expo-out | — | measured |

## 5. Trigger and scroll config
- Pinned horizontal rail: `(min-width: 761px) and (min-height: 600px)` pins sticky while scroll position drives horizontal translateX and scaleX progress bar.
- Magnetic & Tilt triggers: Mouse move / hover with smooth return.
- Reveal: IntersectionObserver threshold 0.12 with rootMargin `0px 0px -6% 0px`.

## 6. Interaction and feel
- Magnetic button hover: 0.32 strength outer, 0.22 inner parallax.
- Card 3D tilt: 6-7 degrees max tilt with radial glare reflection.
- Tactile card deck: Hover fans cards out; clicking deals immediately.
- Custom cursor: Smooth lerp coefficient 0.22.

## 7. Responsive and reduced motion
- `prefers-reduced-motion: reduce`: All transforms, magnetic offsets, tilts, cursors, and transitions set to 0.001ms instant display.
- Touch / mobile (`(hover: none) and (pointer: coarse)`): Custom cursor disabled; horizontal track becomes a native touch swipeable rail.

## 8. Dependencies
- Zero external animation libraries: Plain CSS + custom React hooks (`useInView`, `Magnetic`, `Tilt`, `StudioCursor`, `AmbientGlow`).

## 9. Verification
- Next.js 15 App Router production build: Passed with 0 errors.
- TypeScript typecheck: Passed with 0 errors.
- Visual inspection & performance: 60fps GPU transforms on `transform` and `opacity`.

