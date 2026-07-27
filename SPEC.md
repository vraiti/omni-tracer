Create a Python program that traces through vLLM-Omni to generate a JSON of it's live structure.

First, the program traces the initialization sequence and documents the resulting object and coroutine structure. Given a CLI invocation (e.g. `vllm serve --omni Qwen/Qwen-Image-2512` or `vllm serve --omni Qwen/Qwen3-Omni-30B-A3B-Instruct`), it begins at the entrypoint and creates agraph node for every function that is invoked and every object that is created. 

Each node is keyed with a UUID

Function nodes are placed in a JSON object called "functions" and labeled with 
* `"ref":"{file_path}:{function_name}"` 
* `"invokes":[all functions it invokes]"
* `"instantiates":[all objects it instantiates]`
* `"process":{process_UUID}`
* (optional) `"coroutine":{coroutine_UUID}`

Object nodes are placed in a JSON object called "objects" and contain
* `"ref":"{file_path}:{objct_name}"` 
* `"owns":[all objects assigned to it]`
* `"process":{process_UUID}`

