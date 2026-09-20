# Design System

## Direction

专业量化研究工作台。视觉服务于长时间使用、参数核对和结果审阅，以清晰结构和稳定状态为主，不采用行情终端式的装饰性噪音。

## Color

- App background: `#f4f6f8`
- Primary surface: `#ffffff`
- Secondary surface: `#f8fafb`
- Primary accent: `#176b5b`
- Accent hover: `#125548`
- Text strong: `#18211f`
- Text secondary: `#66736f`
- Border: `#dfe6e3`
- Success: `#2f7d5b`
- Warning: `#b7791f`
- Danger: `#c2413b`
- Info: `#376a9f`

State labels must combine color with text or icon. Red and green must not be the only distinction.

## Typography

Use a single product sans stack: `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. Numeric metrics use tabular figures. Base size is 14px; page titles 22px; section titles 16px; labels 13px.

## Layout

Desktop-first app shell with a 224px sidebar and a flexible content canvas. Content width remains fluid for charts and tables. Use 24px page padding, 16px panel gaps and 12px internal control gaps. Below 900px, collapse navigation into a horizontal page switcher and stack primary columns.

Below 680px, keep both navigation labels visible, default the backtest workspace to history with a state-preserving create/history switch, and stack form labels and controls. Use 12px outer and 14px panel padding, 44px primary touch targets, safe-area insets, and container-scrolling data tables (never horizontal scrolling of the whole page). Charts follow viewport height; the drawing toolbar is collapsed by default on phones and remains accessible. Mobile overrides live in `apps/web/src/responsive.css`; desktop behavior and data precision remain unchanged.

## Components

- Cards use 10px radius, a quiet 1px border and minimal shadow.
- Primary actions use the accent color; secondary actions use neutral borders.
- Configuration sections are persistent inline panels, not modal-first flows.
- Forms use consistent label placement and show help/error text beside the affected field.
- Loading uses skeletons where layout is known; empty states explain the next action.
- Strategy versions, task states and unavailable conditions use compact text badges.

## Motion

Use 150–200ms transitions only for state changes and panel expansion. Disable nonessential transitions under `prefers-reduced-motion`.
