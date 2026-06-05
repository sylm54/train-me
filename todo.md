## TTS Update
Add the following tag to the TTS system.

<include src="filename.xml"/>
Includes the content of another XML file at that point. The included file can contain any valid tags and expressions.

## App features
Implement the features outlined in `features.md` to enhance the user experience and provide structured workflows. Each feature should be developed according to the specifications provided, ensuring that they are integrated seamlessly into the main agent's functionality. Pay special attention to the permissions and limitations associated with each feature, as outlined in the documentation.

https://github.com/vercel-labs/just-bash should be used as environment for the main agent, and all features should be compatible with this setup. Ensure that the user can interact with the features as normal user interface.

These files should be used for the prompts for the main agent and its subagents:
prompts\hypno_planner.md
prompts\hypno_writer.md
prompts\main_agent.md
in general the prompts directory should be read only for the agent.
This command in a md file in the prompts directory should embed the content of another md file as part of the current file, allowing for modular and organized prompt management:
{{{embed 'files.md'}}} => Will include the content of prompts/files.md at that point in the current file.

This command in a md file in the prompts directory should embed a overview of all md files at special\**.md files detailing all frontmatter fields.
{{special}}
