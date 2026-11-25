// Lets `node --test games/lego-batman/` work on Node 22+, where a folder argument is loaded
// as a module instead of being searched for test files.
require('./test.js');
