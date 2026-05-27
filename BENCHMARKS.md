# Benchmark Proof Pack

Generated: 2026-05-27T19:27:24.298Z

Iterations: 100 warm, 10 cold

| Runtime             | Metric                |     Value | Unit   | Notes                                                           |
| ------------------- | --------------------- | --------: | ------ | --------------------------------------------------------------- |
| isolated-jsc ffi    | cold isolate mean     |     5.783 | ms     |                                                                 |
| isolated-jsc ffi    | cold isolate p50      |     1.154 | ms     |                                                                 |
| isolated-jsc ffi    | cold isolate p95      |    46.526 | ms     |                                                                 |
| isolated-jsc ffi    | warm callable mean    |     0.314 | ms     |                                                                 |
| isolated-jsc ffi    | warm callable p50     |      0.23 | ms     |                                                                 |
| isolated-jsc ffi    | warm callable p95     |     0.609 | ms     |                                                                 |
| isolated-jsc ffi    | host call mean        |     1.727 | ms     |                                                                 |
| isolated-jsc ffi    | host call p50         |     1.612 | ms     |                                                                 |
| isolated-jsc ffi    | host call p95         |     2.712 | ms     |                                                                 |
| isolated-jsc ffi    | heap after warm calls |   1048576 | bytes  |                                                                 |
| isolated-jsc ffi    | timeout recovery      |        ok | status | 56.128 ms elapsed; isolate survives                             |
| isolated-jsc worker | cold isolate mean     |     27.18 | ms     |                                                                 |
| isolated-jsc worker | cold isolate p50      |    27.545 | ms     |                                                                 |
| isolated-jsc worker | cold isolate p95      |    37.442 | ms     |                                                                 |
| isolated-jsc worker | warm callable mean    |     0.351 | ms     |                                                                 |
| isolated-jsc worker | warm callable p50     |     0.217 | ms     |                                                                 |
| isolated-jsc worker | warm callable p95     |     0.841 | ms     |                                                                 |
| isolated-jsc worker | host call mean        |      0.39 | ms     |                                                                 |
| isolated-jsc worker | host call p50         |      0.29 | ms     |                                                                 |
| isolated-jsc worker | host call p95         |     0.764 | ms     |                                                                 |
| isolated-jsc worker | heap after warm calls | 113287168 | bytes  |                                                                 |
| isolated-jsc worker | timeout recovery      |        ok | status | 59.136 ms elapsed; worker isolate terminates                    |
| process spawn       | cold process mean     |    25.366 | ms     | bun subprocess per execution                                    |
| process spawn       | cold process p50      |    25.776 | ms     | bun subprocess per execution                                    |
| process spawn       | cold process p95      |    28.346 | ms     | bun subprocess per execution                                    |
| process spawn       | timeout recovery      |        ok | status | 51.996 ms elapsed; process killed                               |
| node isolated-vm    | status                |   skipped | status | skipped: install isolated-vm under Node to enable this baseline |

## Notes

- Cold timings include backend startup and library loading. Compare p50 and p95 together before drawing conclusions from a single outlier.
- The FFI backend keeps the isolate usable after a timeout. The Worker backend and process-spawn baseline recover by terminating the execution container.
- The Node isolated-vm baseline is optional because it requires the native package to be installed in a Node environment.

## Reproduce

```bash
bun run bench:proof
```
