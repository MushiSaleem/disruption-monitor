# disruption-monitor
Travel Disruption Verification Engine  Shows verified aviation disruptions at 17 airports. Nothing to install: it runs on GitHub (Actions every 10 minutes) and shows on GitHub Pages.
Set up (about 10 minutes, browser only)
Create the repo. github.com → + → New repository. Name it disruption-monitor, choose Public, tick Add a README, Create.
Add the files. Add file → Upload files. Drag in: index.html, styles.css, app.js, incidents.json, resolved.json, state.json, sources.json. Then create the scripts folder: Add file → Create new file, type scripts/monitor.js in the name box, paste the contents, Commit.
Add the workflow. Add file → Create new file, type .github/workflows/monitor.yml in the name box (the slashes make the folders), paste the contents, Commit.
Allow the robot to save. Settings → Actions → General → Workflow permissions → Read and write permissions → Save.
Turn on the website. Settings → Pages → Source: Deploy from a branch → Branch main, folder / (root) → Save. After 1–2 minutes the page shows at https://YOUR-NAME.github.io/disruption-monitor/.
Test it. Actions tab → Monitor aviation disruptions → Run workflow. A green tick means it worked.
Add sources (the important part)

Open sources.json, click the pencil, paste real links into the empty "url" fields (Eurocontrol, airport operations pages, airline advisory pages, Sabre/Amadeus/Travelport status pages). Commit. Done.

An incident needs 2 different groups to confirm it. FAA + an airport page works for US airports. For other airports you need two pages that name the airport.
Never add news sites.
Rules
Key = Airport + Type (e.g. LHR_ATC). Different types are never merged.
Only the listed events are monitored. Mild weather is ignored unless severe, delay 30+ min, or 10+ cancellations.
Page changes only on: new incident, severity change, airline list change, delay +30 min, cancellations +25, resolved.
Resolved = sources say it is over, or nobody reports it for 3 checks in a row (30 minutes). A source that fails to load never counts as "nobody".
Good to know
GitHub may run the schedule a few minutes late, and pauses it after 60 days of no activity in a repository: click Enable on the Actions tab if that happens.
A free public repo means the incident data is public. Private-repo Pages needs a paid GitHub plan.
Status shows NEW → ACTIVE (quiet) → UPDATED (on chang
