// Sleep forever to simulate a hung resolver subprocess. Used to test the
// linter's 15s timeout path. The test passes a tight timeout via env override
// in the linter — or by stubbing the script path here.
setTimeout(() => {}, 1_000_000);
