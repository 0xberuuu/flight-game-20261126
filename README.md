# Sky Courier — Ring Run

[![Rank](https://make.fun/badge/best-flight-game-20261126-0057/0xberuuu/flight-game-20261126/rank.svg)](https://make.fun/bounty/best-flight-game-20261126-0057)
[![Reward](https://make.fun/badge/best-flight-game-20261126-0057/0xberuuu/flight-game-20261126/reward.svg)](https://make.fun/bounty/best-flight-game-20261126-0057)
[![make.fun](https://make.fun/badge/best-flight-game-20261126-0057.svg)](https://make.fun/bounty/best-flight-game-20261126-0057)

An original offline flight game, built for the make.fun bounty
[Make the best flight game](https://make.fun/bounty/best-flight-game-20261126-0057).

You are a courier pilot flying a valley course at sunset. Thread all **8 glowing rings**,
then bring the plane home for a clean landing on **runway 27**. Low and slow is smooth —
fast and steep is a crater.

## How to play

Open `game/index.html` in a desktop browser. No network, no install, no assets —
the whole game is one HTML page and one JavaScript file.

| Control | Action |
|---|---|
| Arrow keys or mouse | Steer (pitch and bank — bank turns the plane) |
| W / S (or Shift / Ctrl) | Throttle up / down |
| P | Pause |
| R | Restart after a crash or a landing |
| M | Mute the engine and wind sounds |

## The flight

- **Takeoff:** you start airborne at 620 ft over the valley. Full throttle climbs, idle throttle sinks.
- **Rings:** the next ring glows gold; the rest are cyan. Fly through the centre to score 100 points each. A ring's pylon line drops to the ground so you can judge its height.
- **Stall:** below 72 kt the nose drops and you sink — keep the speed up.
- **Landing:** after all 8 rings, line up on runway 27, slow below 150 kt and settle gently (less than ~840 fpm down). Touch down hard, land early, or hit the hills and the flight is over.
- **Score:** 100 per ring + 500 for the landing + a time bonus for a quick course.

## Instruments

Altitude, speed and heading on the HUD, a compass strip, an artificial horizon,
a throttle gauge, vertical speed, a flight-path reticle, and a next-ring distance
readout. Warnings flash for **PULL UP**, **STALL** and **TOO LOW**.

All sound (engine hum, wind, ring chime, touchdown fanfare) is synthesized live
with WebAudio — no audio files.

## For the grader

`main.ts` (Node 22, stdlib only) stages `game/` and `screenshots/` into
`MAKEFUN_OUTPUT_DIR` (or `./out`) and writes `dossier.json` with the vendored
`vendor/makefun-game.ts` library:

```sh
node main.ts
node main.ts   # second run writes byte-identical output
```

## License

MIT — see [LICENSE](LICENSE).
