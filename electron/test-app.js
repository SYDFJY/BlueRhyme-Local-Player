try {
  const electron = require('electron');
  console.log('SUCCESS: electron loaded, keys:', Object.keys(electron));
  process.exit(0);
} catch (e) {
  console.log('FAILED:', e.message);
  process.exit(1);
}
