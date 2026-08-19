# THE FOCUS

Fix the runaway.

A courses unit generated 343,365 characters / 1,329 rows when ~24 were expected. It looped on one
slot, repeating `Dessert (for vegan diet)` 657 times, never emitted `--- THINKING END ---`, never
wrote the table, never wrote a status block. It held the single generation slot for 42 minutes.

That is the problem. Anything that is not making a courses unit stop generating is not the work.
