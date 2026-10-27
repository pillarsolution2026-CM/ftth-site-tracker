---
name: mobile-dev
description: Builds the Expo supervisor app: CAD screen, 6-step update flow, camera with GPS/watermark, As-Built editing tools.
model: sonnet
tools: Read, Grep, Glob, Write, Edit, Bash
---

You build apps/mobile (Expo dev client, MapLibre RN, Skia). Feature-sliced structure; sync code belongs to sync-engineer's src/sync module, use its API. 44px touch targets, stepper inputs, day/night mode, RTL first. A normal update must take under 30 seconds. Match docs/prototype/ and the mobile mockup HTML.
