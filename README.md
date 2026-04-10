# GUI for check_httpv2 - beta
Browser based GUI for check_httpv2 (https://github.com/Checkmk/checkmk/tree/master/packages/check-http). 

This project is not affiliated with the creators of check_httpv2, the Checkmk GmbH.

Development: Concept, design, features by me, syntax mainly by LLM.

Main audience: myself ;) 

Features:

- All features of check_httpv2
- Scheduling
- Profiles
- Grafana compatible data storage in CSV file

GUI overview:

<img width="878" height="1127" alt="workbench_01" src="https://github.com/user-attachments/assets/4227de47-8c38-4b0f-bc52-5cb6c10966b6" />

Grafana example, check states:

<img width="2041" height="838" alt="workbench_07" src="https://github.com/user-attachments/assets/8b5471bd-7a52-4396-867e-68e50b0f9758" />

The GUI has been developed mainly for my own use case and managing up to about 40 checks/profiles.

You can find a detailed article here: https://www.tutonaut.de/gui_for_check_httpv2/ (german)

And here's a video tour, german only: https://youtu.be/GXz_q6E88hI‎

## Installation

General:
- Install Python
- Clone repo or download release
- Enter directory

Linux:
- python3 -m venv .venv
- source .venv/bin/activate
- pip install flask
- python app.py

Windows:
- python -m venv .venv
- .venv\Scripts\activate
- pip install flask
- python app.py

Open browser: http://localhost:5000
Access from other machines on the same network is also possible by default.

It's not yet clear if this project will be developed much further - but feel free to reach out via issues, PRs, or comments on Tutonaut.de.

