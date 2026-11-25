# Fated Rolls

Fated Rolls lets a GM decide the **next d20 roll** of any player, or of themselves, before it is rolled. The player rolls as usual. The chat card and Dice So Nice show the chosen value, and the GM is told when it gets used.

> *The power of fate is a corrupting force! Use it with caution.*

## Features

- **Set the next d20:** pick a fixed value (1–20) or a random range such as 15–19, which looks more natural. Apply it to one roll or to several in a row.
- **Several targets at once:** yourself, everyone, specific players, or the **selected tokens** on the map.
- **NPCs:** select an NPC token and the next d20 you roll for that NPC uses the chosen value.
- **Advantage and disadvantage are handled:** only the kept die changes, and the dropped die is adjusted so the result still makes sense.
- **Panic Roll!:** a button under the token controls. One click and the next single d20 rolled at the table becomes your chosen value. You set the value and the target in the panel.
- **Mercy mode** (optional): when a player rolls low several times in a row, their next d20 is quietly raised.
- **Luck statistics:** the last 20 d20s of each player from the chat log, with their average.
- **Queue overview:** see what is waiting for whom, and cancel any of it with one click.
- **Damage rolls and death saves** (dnd5e only): set the next damage roll to its maximum, its minimum or an exact total, and decide the outcome of the next death saving throw.
- **Optional chat log:** every setting, cancellation and use is whispered to the GMs.

## Security

- Only GMs can open the panel or use the API.
- A setting is sent only to the user it targets. Players never see other players' settings.
- Queued values are not stored in global variables, so players cannot change them from the console.
- A setting is ignored unless the server confirms it came from a GM.
- If a player reloads the page, the GM sends their queued settings back automatically.

## Usage

Open the panel with the **d20 button** in the token controls (GM only), or assign a key under *Configure Controls*. The **lightning button** below it is Panic Roll!.

The first time a GM opens the panel, a short warning appears.

### API

GM clients only:

```js
const fated = game.modules.get("fated-rolls").api;

fated.setNextD20(17, userId);                 // next d20 of a user
fated.setNextD20([18, 3, 20], "all");         // next three d20s of everyone, in order
fated.setNextD20(20, "self", { count: 2 });   // your next two d20s
fated.setNextD20ForActor(actor, [1]);         // next d20 you roll for this actor (NPC)
fated.setNextDamage([{ type: "max" }], userId);         // dnd5e
fated.setNextDeathSave([20], userId);                   // dnd5e
fated.panicRoll();
fated.cancel("all");
fated.openPanel();
```

## Settings

| Setting | Default | Description |
|---|---|---|
| Log to chat | off | Whisper every setting, cancellation and use to the GMs. |
| Mercy mode | off | Raise a player's next d20 after a streak of low rolls. |
| Mercy: low roll is below | 8 | A natural d20 below this counts as low. |
| Mercy: low rolls in a row | 4 | How many low rolls in a row before mercy steps in. |
| Mercy: lowest / highest new value | 12 / 17 | The range the raised d20 is picked from. |

## System support

- **d20 settings, Panic Roll!, mercy mode and luck statistics** work in any system that rolls d20s through Foundry's dice, such as D&D 5e, Pathfinder 2e or 13th Age. They do nothing in systems without d20s.
- **Damage rolls and death saves** are for D&D 5e only. Other systems don't show those sections.
- NPC targeting matches the exact actor in D&D 5e. Other systems match the actor by name.

## Requirements

- Foundry VTT v14
- [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper)

## Installation

In Foundry, go to *Add-on Modules → Install Module* and search for **Fated Rolls**. You can also paste this manifest URL:

```
https://github.com/mayflower-may/fated-rolls/releases/latest/download/module.json
```

## License

MIT
