# Test photos

Real gauge photos for measuring AI reading accuracy with `npm run test:photos`.
Photos themselves are git-ignored (they may show people or homes); only this README is committed.

Name each file with the true level first, then the station id, then anything else:

```
15.40_sto-nino_morning.jpg
16.05_sto-nino_rain-on-lens.jpg
3.15_demo.png
```

The true level should come from a careful on-site reading at the moment the photo was taken.
Include hard cases on purpose: night, rain, glare, waves, debris, partly blocked gauge.

The script reports the mean absolute error, how many reads fall within ±0.05 m and ±0.10 m,
and lists any photo the model read confidently (≥ 0.85) but wrongly by more than 0.10 m.
Those photos matter most, because a confident AI-only reading is accepted without a human.
