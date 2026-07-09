const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = require('./app');
const config = require('./config/env');

app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
});
