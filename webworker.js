importScripts("https://cdn.jsdelivr.net/pyodide/v0.20.0/full/pyodide.js");

function log(line) {
  console.log({line})
  self.postMessage({type: 'log', line: line});
}

async function startDatasette(settings) {
  let toLoad = [];
  let toMount = [];
  let csvs = [];
  let sqls = [];
  let needsDataDb = false;
  let shouldLoadDefaults = true;
  if (settings.initialUrl) {
    let name = settings.initialUrl.split('.db')[0].split('/').slice(-1)[0];
    toMount.push([name, settings.initialUrl]);
    shouldLoadDefaults = false;
  }
  if (settings.csvUrls && settings.csvUrls.length) {
    csvs = settings.csvUrls;
    needsDataDb = true;
    shouldLoadDefaults = false;
  }
  if (settings.sqlUrls && settings.sqlUrls.length) {
    sqls = settings.sqlUrls;
    needsDataDb = true;
    shouldLoadDefaults = false;
  }
  if (needsDataDb) {
    toLoad.push(["data.db", 0]);
  }
  if (shouldLoadDefaults) {
    toMount.push(["fixtures.db", "https://latest.datasette.io/fixtures.db"]);
    toMount.push(["content.db", "https://datasette.io/content.db"]);
  }
  self.pyodide = await loadPyodide({
    indexURL: "https://cdn.jsdelivr.net/pyodide/v0.20.0/full/"
  });

  for (let [name, url] of toMount) {
    pyodide.FS.createLazyFile('/home/pyodide', name, url, true, false)
  }

  await pyodide.loadPackage('micropip', log);
  await pyodide.loadPackage('ssl', log);
  await pyodide.loadPackage('setuptools', log); // For pkg_resources
  try {
    await self.pyodide.runPythonAsync(`
    # Grab that fixtures.db database
    import sqlite3
    from pyodide.http import pyfetch
    names = []
    for name, url in ${JSON.stringify(toLoad)}:
        if url:
            response = await pyfetch(url)
            with open(name, "wb") as fp:
                fp.write(await response.bytes())
        else:
            sqlite3.connect(name).execute("vacuum")
        names.append(name)
    for name, url in ${JSON.stringify(toMount)}:
      sqlite3.connect(f"file:{name}?mode=ro", uri=True)
      names.append(name)

    import micropip
    # Workaround for Requested 'h11<0.13,>=0.11', but h11==0.13.0 is already installed
    await micropip.install("h11==0.12.0")
    await micropip.install("datasette")
    # Install any extra ?install= dependencies
    install_urls = ${JSON.stringify(settings.installUrls)}
    if install_urls:
        for install_url in install_urls:
            await micropip.install(install_url)
    # Execute any ?sql=URL SQL
    sqls = ${JSON.stringify(sqls)}
    if sqls:
        for sql_url in sqls:
            # Fetch that SQL and execute it
            response = await pyfetch(sql_url)
            sql = await response.string()
            sqlite3.connect("data.db").executescript(sql)
    # Import data from ?csv=URL CSV files
    csvs = ${JSON.stringify(csvs)}
    if csvs:
        await micropip.install("sqlite-utils==3.28")
        import sqlite_utils
        from sqlite_utils.utils import rows_from_file, TypeTracker, Format
        db = sqlite_utils.Database("data.db")
        table_names = set()
        for csv_url in csvs:
            # Derive table name from CSV URL
            bit = csv_url.split("/")[-1].split(".")[0].split("?")[0]
            bit = bit.strip()
            if not bit:
                bit = "table"
            prefix = 0
            base_bit = bit
            while bit in table_names:
                prefix += 1
                bit = "{}_{}".format(base_bit, prefix)
            table_names.add(bit)
            tracker = TypeTracker()
            response = await pyfetch(csv_url)
            with open("csv.csv", "wb") as fp:
                fp.write(await response.bytes())
            db[bit].insert_all(
                tracker.wrap(rows_from_file(open("csv.csv", "rb"), Format.CSV)[0])
            )
            db[bit].transform(
                types=tracker.types
            )
    from datasette.app import Datasette
    ds = Datasette(names, settings={
        "num_sql_threads": 0,
        "sql_time_limit_ms": 100000,
    }, metadata = {
        "about": "Datasette Lite",
        "about_url": "https://github.com/simonw/datasette-lite"
    })
    await ds.invoke_startup()
    `);
    datasetteLiteReady();
  } catch (error) {
    self.postMessage({error: error.message});
  }
}

// Outside promise pattern
// https://github.com/simonw/datasette-lite/issues/25#issuecomment-1116948381
let datasetteLiteReady;
let readyPromise = new Promise(function(resolve) {
  datasetteLiteReady = resolve;
});

self.onmessage = async (event) => {
  console.log({event, data: event.data});
  if (event.data.type == 'startup') {
    await startDatasette(event.data);
    return;
  }
  // make sure loading is done
  await readyPromise;
  console.log(event, event.data);
  try {
    let [status, contentType, text] = await self.pyodide.runPythonAsync(
      `
      import json
      response = await ds.client.get(
          ${JSON.stringify(event.data.path)},
          follow_redirects=True
      )
      [response.status_code, response.headers.get("content-type"), response.text]
      `
    );
    self.postMessage({status, contentType, text});
  } catch (error) {
    self.postMessage({error: error.message});
  }
};
