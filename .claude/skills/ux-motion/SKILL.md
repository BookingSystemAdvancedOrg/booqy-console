---
name: ux-motion
description: Use when building or reviewing UI animation, transitions, hover and press states, menus, modals, toasts, drag interactions, or any interface where something moves. Applies 20 animation and UX principles (squash and stretch through frequency of use) with concrete timings, easings and sizes, and flags where a design breaks them.
---

# UX motion: 20 principles

Use this whenever you build or review an interface that moves. Every principle below has a number you can apply directly. Pick the ones that fit the moment. Most screens need four or five, not all twenty.

When you build, apply the rules quietly and mention the important choices in one line each. When you review, list each problem with the principle it breaks, where it happens, and the fix.

## 1. Squash and stretch

Things squish on impact, which gives them weight. On a bounce or a press, squash one axis and stretch the other so the area stays about the same (scaleX 1.1 with scaleY 0.9). Keep it between 80 and 150ms. Use it on physical, playful elements like toggles, like buttons and draggable cards. Never squash text, numbers or data.

## 2. Anticipation

A small move in the opposite direction right before the main action, like a crouch before a jump. A send button can swing back before it flies off; a card can dip before it gets flung away. The wind-up runs 60 to 200ms and travels roughly 5 to 25 percent of the main move. Save it for launches and big moves. A plain button doesn't need one.

## 3. Stagger

Bring lists in one item after another instead of all at once. Use 30 to 60ms between items and keep the whole cascade under about 300ms. Past the first 6 to 8 items, show the rest together so long lists don't make people wait.

## 4. Follow through

Parts keep moving after the main body stops, then settle. Let children lag the parent by 20 to 60ms, or use a spring with a small overshoot (damping ratio around 0.7 to 0.85). Good on sheets, cards with avatars, and anything with loose parts.

## 5. Slow in, slow out

Nothing in real life moves at a constant speed. Use ease-out for things entering (`cubic-bezier(0.16, 1, 0.3, 1)`), ease-in for things leaving (`cubic-bezier(0.7, 0, 0.84, 0)`), and ease-in-out for things moving from one spot on screen to another (`cubic-bezier(0.65, 0, 0.35, 1)`). Linear is only for spinners, progress bars and marquees.

## 6. Moving in arcs

Things that travel diagonally should curve. Animate x and y with different easings (ease-out on one axis, ease-in on the other) and the path bends on its own. Straight diagonal lines look mechanical. Short moves under about 40px can stay straight.

## 7. Secondary action

A small motion that backs up the main one: the heart fills while the count ticks up, the checkmark draws while the button turns green. It runs at the same time or right after, and it's always smaller and quieter than the main action. If it competes for attention, cut it.

## 8. Snappy timing

Duration sets the feel. Small feedback like hover and press: 100 to 150ms. Most UI transitions: 150 to 300ms. Large panels and full-screen moves: up to about 400ms. Anything over 500ms feels slow unless it's a one-time moment like onboarding.

## 9. Exaggerated feedback

Push it past real so the moment lands. A like can pop to 1.2x before settling, and a wrong password can shake 3 times over about 300ms. Keep it short and save it for moments that matter. If everything is exaggerated, nothing stands out.

## 10. Solid drawing in 3D

Give flat things depth. Use layered shadows, a light highlight on top edges, and small perspective tilts (rotateX or rotateY up to about 10 to 15 degrees with `perspective` around 800 to 1200px). Cards that tilt toward the cursor and buttons that press down into the page both use this.

## 11. Origin awareness

Things should grow from what you clicked. Set `transform-origin` to the trigger: a dropdown scales from its button, a popover from its anchor, a modal from the card that opened it. Radix exposes `--radix-popover-content-transform-origin` for this. Scaling from the center of the screen breaks the link between cause and effect.

## 12. Fitts's law

Bigger, closer targets are faster to hit. Make touch targets at least 44 by 44pt (Apple) or 48 by 48dp (Material), even when the visible icon is smaller; pad the hit area instead. Put frequent actions near where the pointer or thumb already is. On desktop, screen edges and corners are the easiest targets of all.

## 13. Rubber banding

When someone drags past the edge, stretch instead of stopping dead. Move the content by a shrinking fraction of the drag, for example `offset = (1 - 1 / (drag * 0.55 / size + 1)) * size`, then spring back on release. A hard wall feels broken; resistance tells people they hit the end.

## 14. Hick's law

More choices mean slower decisions. Cut options, group the rest, and hide advanced settings behind a "More" or a second step. When one option is the right pick for most people, mark it as recommended.

## 15. Von Restorff

The one that stands out gets remembered. Give the main action or the recommended plan a different color, size or treatment from everything around it. Only one thing per view gets this. Two highlighted items cancel each other out.

## 16. Doherty threshold

Respond within 400ms or it feels slow, and show some feedback within 100ms. If the real work takes longer, update the UI right away (optimistic updates), show a skeleton, or show progress. Never leave a click with no visible response.

## 17. Interruptible motion

Let people change their mind mid-animation. Animate from the current value, not from the start, and never block input while something moves. CSS transitions and springs (Motion, React Spring) retarget smoothly. CSS keyframe animations restart from the beginning, so avoid them for anything the user can reverse, like menus, drawers and toggles.

## 18. Fast closing

Close faster than you open. When someone opens something, the motion shows where it came from. When they close it, they're already done with it, so get out of the way. Make exits about half to a third of the entry: open in 250ms with ease-out, close in 100 to 150ms with ease-in.

## 19. Peak-end rule

People judge an experience by its best or worst moment and by how it ends. Give the end of a flow a real moment, like a checkmark that draws in, a short success animation, or a clear summary. Also find the most frustrating step and fix it first, because people remember that one too.

## 20. Frequency of use

The more something is used, the less it should animate. A command palette opened 50 times a day should appear almost instantly with no flourish. Onboarding, first-time success and rare celebrations can take more time and more motion. Always respect `prefers-reduced-motion`: swap movement for a quick fade or no animation.

## Quick checks before you ship

- Does every animation have a reason (feedback, orientation or emphasis)?
- Are durations inside the ranges above, and does closing run faster than opening?
- Does every popover, menu and modal grow from its trigger?
- Can a user interrupt or reverse anything that moves?
- Does the UI respond within 100ms to every click and tap?
- Does it still work with `prefers-reduced-motion` turned on?
