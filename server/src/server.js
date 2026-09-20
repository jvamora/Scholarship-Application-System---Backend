require('dotenv').config();

const app = require('./app');
const { sweepExpiredAwards } = require('./services/selectionService');

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Sweep expired awards once per hour. Idempotent and slot-guarded, so a
// double-fire (e.g. across restarts) is harmless. Lazy checks on reads
// handle promptness between sweeps.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
setInterval(() => {
  sweepExpiredAwards()
    .then((r) => {
      if (r && (r.forfeited > 0 || r.promoted > 0)) {
        console.log(`[award-sweep] forfeited=${r.forfeited} promoted=${r.promoted}`);
      }
    })
    .catch((e) => console.error('[award-sweep] failed:', e.message));
}, SWEEP_INTERVAL_MS);

