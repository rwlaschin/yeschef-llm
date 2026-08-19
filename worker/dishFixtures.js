// 24 standardized single-dish recipes, every one of which returns [] from validateRecipe.
// Fixture data for the fake generator and for tests that need a real production sheet to work from.

export const DISH_FIXTURES = [
  {
    "name": "Oven-Roasted Boneless Chicken Thigh",
    "kind": "entree",
    "diets": [
      "standard",
      "low-sodium",
      "gluten-free",
      "diabetic",
      "lactose-free"
    ],
    "yieldPortions": 50,
    "portionSize": "1 thigh (4 oz cooked)",
    "components": [
      {
        "ingredient": "Boneless skinless chicken thighs, 5 oz each",
        "category": "protein",
        "quantity": 16,
        "unit": "lb",
        "prep": "thawed, trimmed of visible fat, patted dry"
      },
      {
        "ingredient": "Vegetable oil",
        "category": "fat",
        "quantity": 4,
        "unit": "fl oz",
        "prep": "none"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Paprika",
        "quantity": 2,
        "unit": "oz"
      },
      {
        "ingredient": "Granulated garlic",
        "quantity": 1,
        "unit": "oz"
      },
      {
        "ingredient": "Salt-free herb seasoning blend",
        "quantity": 2,
        "unit": "oz"
      },
      {
        "ingredient": "Ground black pepper",
        "quantity": 0.5,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Combine oil, paprika, granulated garlic, herb blend and black pepper in a mixing bowl to form a rub.",
        "phase": "make_ahead",
        "timeMin": 5
      },
      {
        "order": 1,
        "text": "Toss thighs with the rub until evenly coated. Arrange smooth side up in a single layer on sheet pans, 25 thighs per full sheet pan lined with parchment.",
        "phase": "make_ahead",
        "timeMin": 20
      },
      {
        "order": 2,
        "text": "Roast at 400F in a convection oven for 22-28 minutes until the thickest thigh registers 165F for 15 seconds.",
        "phase": "on_line",
        "timeMin": 28,
        "criticalTempF": 165
      },
      {
        "order": 3,
        "text": "Transfer to hotel pans with 1/2 cup water in the bottom, cover, and hold at 135F or above. Discard after 4 hours of service.",
        "phase": "on_line",
        "criticalTempF": 135
      },
      {
        "order": 4,
        "text": "Plate 1 thigh per portion with tongs, smooth side up.",
        "phase": "on_line",
        "timeMin": 2
      }
    ],
    "nutrition": {
      "kcal": 245,
      "proteinG": 27,
      "fatG": 14,
      "carbG": 1,
      "sodiumMg": 130,
      "potassiumMg": 340,
      "phosphorusMg": 235,
      "sugarG": 0,
      "fluidMl": 0
    }
  },
  {
    "name": "Baked Lemon-Herb Cod Fillet",
    "kind": "entree",
    "diets": [
      "standard",
      "low-sodium",
      "low-fat",
      "gluten-free",
      "diabetic",
      "lactose-free"
    ],
    "yieldPortions": 50,
    "portionSize": "4 oz fillet",
    "components": [
      {
        "ingredient": "Cod fillets, 4.5 oz portions",
        "category": "protein",
        "quantity": 14,
        "unit": "lb",
        "prep": "thawed under refrigeration, patted dry"
      },
      {
        "ingredient": "Olive oil",
        "category": "fat",
        "quantity": 8,
        "unit": "fl oz",
        "prep": "none"
      },
      {
        "ingredient": "Lemon juice",
        "category": "fruit",
        "quantity": 8,
        "unit": "fl oz",
        "prep": "fresh or bottled"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Dried parsley",
        "quantity": 1,
        "unit": "oz"
      },
      {
        "ingredient": "Dried dill weed",
        "quantity": 0.5,
        "unit": "oz"
      },
      {
        "ingredient": "Ground black pepper",
        "quantity": 0.5,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Whisk olive oil, lemon juice, parsley, dill and black pepper together.",
        "phase": "make_ahead",
        "timeMin": 5
      },
      {
        "order": 1,
        "text": "Arrange fillets in a single layer in lightly oiled 12x20x2 pans, 17 fillets per pan. Spoon 1 tablespoon of the lemon-herb mixture over each fillet.",
        "phase": "make_ahead",
        "timeMin": 20
      },
      {
        "order": 2,
        "text": "Bake uncovered at 350F convection for 12-16 minutes until fish flakes and center reaches 145F for 15 seconds.",
        "phase": "on_line",
        "timeMin": 16,
        "criticalTempF": 145
      },
      {
        "order": 3,
        "text": "Hold covered at 135F or above. Fish quality degrades after 1 hour of hot holding; bake in batches sized to service flow.",
        "phase": "on_line",
        "timeMin": 5,
        "criticalTempF": 135
      },
      {
        "order": 4,
        "text": "Plate 1 fillet per portion with an offset spatula so the fillet does not break.",
        "phase": "on_line",
        "timeMin": 2
      }
    ],
    "nutrition": {
      "kcal": 160,
      "proteinG": 24,
      "fatG": 6,
      "carbG": 1,
      "sodiumMg": 95,
      "potassiumMg": 460,
      "phosphorusMg": 220,
      "sugarG": 0,
      "fluidMl": 0
    }
  },
  {
    "name": "Slow-Braised Beef Pot Roast, Sliced",
    "kind": "entree",
    "diets": [
      "standard",
      "gluten-free",
      "lactose-free"
    ],
    "yieldPortions": 50,
    "portionSize": "3 oz sliced beef with 2 oz jus",
    "components": [
      {
        "ingredient": "Beef chuck roast, boneless",
        "category": "protein",
        "quantity": 22,
        "unit": "lb",
        "prep": "trimmed, cut into 4-5 lb pieces"
      },
      {
        "ingredient": "Vegetable oil",
        "category": "fat",
        "quantity": 6,
        "unit": "fl oz",
        "prep": "none"
      },
      {
        "ingredient": "Yellow onions",
        "category": "vegetable",
        "quantity": 3,
        "unit": "lb",
        "prep": "peeled, sliced 1/4 inch"
      },
      {
        "ingredient": "Carrots",
        "category": "vegetable",
        "quantity": 2,
        "unit": "lb",
        "prep": "peeled, cut into 1 inch pieces"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Low-sodium beef broth",
        "quantity": 1,
        "unit": "gal"
      },
      {
        "ingredient": "Ground black pepper",
        "quantity": 0.75,
        "unit": "oz"
      },
      {
        "ingredient": "Dried thyme",
        "quantity": 0.5,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Season beef pieces with black pepper and thyme. Sear in oil in a tilt skillet at 375F, about 4 minutes per side, until well browned.",
        "phase": "make_ahead",
        "timeMin": 40,
        "criticalTempF": 375
      },
      {
        "order": 1,
        "text": "Place the browned beef in 12x20x4 pans. Scatter onions and carrots over the top and add broth to come halfway up the meat.",
        "phase": "make_ahead",
        "timeMin": 15
      },
      {
        "order": 2,
        "text": "Cover tightly with foil and braise at 300F for 3.5 to 4 hours until fork tender, internal temperature about 195F.",
        "phase": "make_ahead",
        "timeMin": 240,
        "criticalTempF": 195
      },
      {
        "order": 3,
        "text": "Rest covered 30 minutes, then slice across the grain 1/4 inch thick. Return slices to the strained braising liquid.",
        "phase": "make_ahead",
        "timeMin": 45,
        "criticalTempF": 135
      },
      {
        "order": 4,
        "text": "Reheat to 165F before service and hold at 135F or above. Serve 3 oz beef with a 2 oz ladle of jus.",
        "phase": "on_line",
        "timeMin": 25,
        "criticalTempF": 165
      }
    ],
    "nutrition": {
      "kcal": 265,
      "proteinG": 26,
      "fatG": 16,
      "carbG": 3,
      "sodiumMg": 175,
      "potassiumMg": 390,
      "phosphorusMg": 210,
      "sugarG": 2,
      "fluidMl": 60
    }
  },
  {
    "name": "Baked Lentil and Mushroom Loaf, Sliced",
    "kind": "entree",
    "diets": [
      "vegan",
      "vegetarian",
      "low-sodium",
      "gluten-free",
      "lactose-free",
      "low-fat"
    ],
    "yieldPortions": 48,
    "portionSize": "1 slice (4 oz)",
    "components": [
      {
        "ingredient": "Brown lentils, dry",
        "category": "protein",
        "quantity": 4,
        "unit": "lb",
        "prep": "rinsed, sorted"
      },
      {
        "ingredient": "White button mushrooms",
        "category": "vegetable",
        "quantity": 5,
        "unit": "lb",
        "prep": "washed, chopped 1/4 inch"
      },
      {
        "ingredient": "Yellow onions",
        "category": "vegetable",
        "quantity": 2,
        "unit": "lb",
        "prep": "peeled, small dice"
      },
      {
        "ingredient": "Gluten-free rolled oats",
        "category": "starch",
        "quantity": 2,
        "unit": "lb",
        "prep": "none"
      },
      {
        "ingredient": "No-salt-added tomato paste",
        "category": "vegetable",
        "quantity": 12,
        "unit": "oz",
        "prep": "none"
      },
      {
        "ingredient": "Vegetable oil",
        "category": "fat",
        "quantity": 8,
        "unit": "fl oz",
        "prep": "none"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Water",
        "quantity": 2.5,
        "unit": "gal"
      },
      {
        "ingredient": "Granulated garlic",
        "quantity": 1,
        "unit": "oz"
      },
      {
        "ingredient": "Dried thyme",
        "quantity": 0.5,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Simmer lentils in water 25-30 minutes until soft but not broken. Drain well and cool to 41F within 4 hours in a shallow pan.",
        "phase": "make_ahead",
        "timeMin": 35,
        "criticalTempF": 41
      },
      {
        "order": 1,
        "text": "Sweat onions and mushrooms in oil over medium heat 12-15 minutes until the released liquid has evaporated.",
        "phase": "make_ahead",
        "timeMin": 15,
        "criticalTempF": 135
      },
      {
        "order": 2,
        "text": "Combine lentils, vegetable mixture, oats, tomato paste, garlic and thyme. Mash roughly so the mixture binds when pressed.",
        "phase": "make_ahead",
        "timeMin": 15
      },
      {
        "order": 3,
        "text": "Press 12 lb of mixture into each of two lightly oiled 12x20x2 pans, level the surface, and bake at 350F for 45-55 minutes until set and 165F at center.",
        "phase": "make_ahead",
        "timeMin": 55,
        "criticalTempF": 165
      },
      {
        "order": 4,
        "text": "Rest 15 minutes, then cut each pan 4x6 into 24 portions. Hold covered at 135F or above.",
        "phase": "on_line",
        "criticalTempF": 135
      }
    ],
    "nutrition": {
      "kcal": 230,
      "proteinG": 12,
      "fatG": 7,
      "carbG": 31,
      "sodiumMg": 65,
      "potassiumMg": 520,
      "phosphorusMg": 215,
      "sugarG": 3,
      "fluidMl": 0
    }
  },
  {
    "name": "Simmered Split Pea Soup",
    "kind": "soup",
    "diets": [
      "vegan",
      "vegetarian",
      "low-sodium",
      "gluten-free",
      "low-fat",
      "lactose-free"
    ],
    "yieldPortions": 50,
    "portionSize": "1 cup (8 fl oz)",
    "components": [
      {
        "ingredient": "Green split peas, dry",
        "category": "protein",
        "quantity": 6,
        "unit": "lb",
        "prep": "rinsed, sorted"
      },
      {
        "ingredient": "Carrots",
        "category": "vegetable",
        "quantity": 3,
        "unit": "lb",
        "prep": "peeled, small dice"
      },
      {
        "ingredient": "Celery",
        "category": "vegetable",
        "quantity": 2,
        "unit": "lb",
        "prep": "washed, small dice"
      },
      {
        "ingredient": "Yellow onions",
        "category": "vegetable",
        "quantity": 2,
        "unit": "lb",
        "prep": "peeled, small dice"
      },
      {
        "ingredient": "Vegetable oil",
        "category": "fat",
        "quantity": 6,
        "unit": "fl oz",
        "prep": "none"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Low-sodium vegetable broth",
        "quantity": 3,
        "unit": "gal"
      },
      {
        "ingredient": "Dried thyme",
        "quantity": 0.5,
        "unit": "oz"
      },
      {
        "ingredient": "Ground black pepper",
        "quantity": 0.5,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Sweat onions, carrots and celery in oil in a jacketed kettle 10 minutes until onions are translucent.",
        "phase": "make_ahead",
        "timeMin": 10,
        "criticalTempF": 135
      },
      {
        "order": 1,
        "text": "Add split peas, broth, thyme and pepper. Bring to a boil, then reduce to a simmer.",
        "phase": "make_ahead",
        "timeMin": 15,
        "criticalTempF": 212
      },
      {
        "order": 2,
        "text": "Simmer uncovered 60-75 minutes, stirring every 15 minutes to prevent scorching, until peas break down and soup coats a spoon.",
        "phase": "make_ahead",
        "timeMin": 75,
        "criticalTempF": 165
      },
      {
        "order": 3,
        "text": "If holding overnight, cool from 135F to 70F within 2 hours and to 41F within 4 more hours in shallow pans.",
        "phase": "make_ahead",
        "timeMin": 360,
        "criticalTempF": 41
      },
      {
        "order": 4,
        "text": "Reheat to 165F, thin with hot broth to a ladling consistency, and hold at 135F or above. Serve with an 8 oz ladle.",
        "phase": "on_line",
        "timeMin": 25,
        "criticalTempF": 165
      }
    ],
    "nutrition": {
      "kcal": 215,
      "proteinG": 12,
      "fatG": 4,
      "carbG": 34,
      "sodiumMg": 110,
      "potassiumMg": 590,
      "phosphorusMg": 185,
      "sugarG": 4,
      "fluidMl": 240
    }
  },
  {
    "name": "Chicken Noodle Soup",
    "kind": "soup",
    "diets": [
      "standard",
      "low-sodium",
      "low-fat",
      "lactose-free"
    ],
    "yieldPortions": 50,
    "portionSize": "1 cup (8 fl oz)",
    "components": [
      {
        "ingredient": "Cooked diced chicken meat",
        "category": "protein",
        "quantity": 6,
        "unit": "lb",
        "prep": "1/2 inch dice, chilled"
      },
      {
        "ingredient": "Egg noodles, dry",
        "category": "starch",
        "quantity": 3,
        "unit": "lb",
        "prep": "none"
      },
      {
        "ingredient": "Carrots",
        "category": "vegetable",
        "quantity": 3,
        "unit": "lb",
        "prep": "peeled, sliced 1/8 inch"
      },
      {
        "ingredient": "Celery",
        "category": "vegetable",
        "quantity": 2,
        "unit": "lb",
        "prep": "washed, sliced 1/8 inch"
      },
      {
        "ingredient": "Yellow onions",
        "category": "vegetable",
        "quantity": 1.5,
        "unit": "lb",
        "prep": "peeled, small dice"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Low-sodium chicken broth",
        "quantity": 3,
        "unit": "gal"
      },
      {
        "ingredient": "Dried parsley",
        "quantity": 0.75,
        "unit": "oz"
      },
      {
        "ingredient": "Ground black pepper",
        "quantity": 0.5,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Bring broth to a simmer at 185F in a kettle. Add carrots, celery and onions and simmer 12 minutes until tender-crisp.",
        "phase": "make_ahead",
        "timeMin": 20,
        "criticalTempF": 185
      },
      {
        "order": 1,
        "text": "Cook noodles separately in boiling water 6-8 minutes, drain, and rinse briefly so they do not absorb the broth in holding.",
        "phase": "make_ahead",
        "timeMin": 12,
        "criticalTempF": 212
      },
      {
        "order": 2,
        "text": "Add diced chicken, parsley and pepper to the broth and heat to 165F for 15 seconds.",
        "phase": "on_line",
        "timeMin": 15,
        "criticalTempF": 165
      },
      {
        "order": 3,
        "text": "Add cooked noodles to the kettle no more than 30 minutes before service to keep texture. Hold at 135F or above.",
        "phase": "on_line",
        "criticalTempF": 135
      },
      {
        "order": 4,
        "text": "Ladle 8 fl oz per portion, drawing from the bottom of the kettle so each bowl gets noodles and chicken.",
        "phase": "on_line",
        "timeMin": 2
      }
    ],
    "nutrition": {
      "kcal": 175,
      "proteinG": 16,
      "fatG": 4,
      "carbG": 18,
      "sodiumMg": 190,
      "potassiumMg": 330,
      "phosphorusMg": 150,
      "sugarG": 2,
      "fluidMl": 230
    }
  },
  {
    "name": "Creamy Tomato Basil Soup",
    "kind": "soup",
    "diets": [
      "vegetarian",
      "gluten-free",
      "low-sodium"
    ],
    "yieldPortions": 50,
    "portionSize": "1 cup (8 fl oz)",
    "components": [
      {
        "ingredient": "No-salt-added crushed tomatoes, canned",
        "category": "vegetable",
        "quantity": 12,
        "unit": "lb",
        "prep": "undrained"
      },
      {
        "ingredient": "Yellow onions",
        "category": "vegetable",
        "quantity": 2,
        "unit": "lb",
        "prep": "peeled, small dice"
      },
      {
        "ingredient": "Heavy cream",
        "category": "dairy",
        "quantity": 1,
        "unit": "qt",
        "prep": "none"
      },
      {
        "ingredient": "Unsalted butter",
        "category": "fat",
        "quantity": 8,
        "unit": "oz",
        "prep": "none"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Low-sodium vegetable broth",
        "quantity": 1.5,
        "unit": "gal"
      },
      {
        "ingredient": "Granulated sugar",
        "quantity": 3,
        "unit": "oz"
      },
      {
        "ingredient": "Dried basil",
        "quantity": 1,
        "unit": "oz"
      },
      {
        "ingredient": "Ground black pepper",
        "quantity": 0.25,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Sweat onions in butter 10 minutes until soft with no color.",
        "phase": "make_ahead",
        "timeMin": 10,
        "criticalTempF": 135
      },
      {
        "order": 1,
        "text": "Add tomatoes, broth, sugar, basil and pepper. Simmer at 185F for 30 minutes uncovered.",
        "phase": "make_ahead",
        "timeMin": 30,
        "criticalTempF": 185
      },
      {
        "order": 2,
        "text": "Puree with an immersion blender until smooth.",
        "phase": "make_ahead",
        "timeMin": 10
      },
      {
        "order": 3,
        "text": "Temper in the cream off direct heat and bring back to 165F without boiling, or the soup will break.",
        "phase": "on_line",
        "timeMin": 12,
        "criticalTempF": 165
      },
      {
        "order": 4,
        "text": "Hold at 135F or above, stirring every 20 minutes. Do not hold longer than 2 hours after cream is added.",
        "phase": "on_line",
        "criticalTempF": 135
      },
      {
        "order": 5,
        "text": "Ladle 8 fl oz per portion and garnish with a basil chiffonade.",
        "phase": "on_line",
        "timeMin": 2
      }
    ],
    "nutrition": {
      "kcal": 165,
      "proteinG": 3,
      "fatG": 11,
      "carbG": 14,
      "sodiumMg": 105,
      "potassiumMg": 430,
      "phosphorusMg": 75,
      "sugarG": 9,
      "fluidMl": 235
    }
  },
  {
    "name": "Tossed Garden Salad with Cucumber and Tomato",
    "kind": "salad",
    "diets": [
      "vegan",
      "vegetarian",
      "gluten-free",
      "low-sodium",
      "low-fat",
      "diabetic",
      "lactose-free"
    ],
    "yieldPortions": 50,
    "portionSize": "1.5 cup (3 oz)",
    "components": [
      {
        "ingredient": "Romaine lettuce",
        "category": "vegetable",
        "quantity": 8,
        "unit": "lb",
        "prep": "washed, chopped 1 inch, spun dry"
      },
      {
        "ingredient": "Grape tomatoes",
        "category": "vegetable",
        "quantity": 3,
        "unit": "lb",
        "prep": "washed, halved"
      },
      {
        "ingredient": "Cucumbers",
        "category": "vegetable",
        "quantity": 3,
        "unit": "lb",
        "prep": "washed, sliced 1/4 inch"
      },
      {
        "ingredient": "Carrots",
        "category": "vegetable",
        "quantity": 1.5,
        "unit": "lb",
        "prep": "peeled, shredded"
      },
      {
        "ingredient": "Red onion",
        "category": "vegetable",
        "quantity": 0.75,
        "unit": "lb",
        "prep": "peeled, sliced paper thin"
      }
    ],
    "seasonings": [],
    "seasoningsNote": "No seasonings: the dressing carries all salt and acid and is served on the side so sodium is controlled per tray.",
    "method": [
      {
        "order": 0,
        "text": "Wash all produce in cold running water. Spin or drain lettuce completely dry so dressing will cling at service.",
        "phase": "make_ahead",
        "timeMin": 30
      },
      {
        "order": 1,
        "text": "Hold prepped components in separate covered containers at 41F or below until service.",
        "phase": "make_ahead",
        "criticalTempF": 41
      },
      {
        "order": 2,
        "text": "Combine lettuce, cucumber, carrot and onion in a bowl chilled to 41F or below, no more than 30 minutes before service. Toss gently.",
        "phase": "on_line",
        "timeMin": 10,
        "criticalTempF": 41
      },
      {
        "order": 3,
        "text": "Portion 1.5 cup into chilled salad bowls and top each with 6 tomato halves. Serve dressing on the side. Hold plated salads at 41F or below.",
        "phase": "on_line",
        "criticalTempF": 41
      }
    ],
    "nutrition": {
      "kcal": 35,
      "proteinG": 2,
      "fatG": 0,
      "carbG": 7,
      "sodiumMg": 20,
      "potassiumMg": 380,
      "phosphorusMg": 45,
      "sugarG": 4,
      "fluidMl": 0
    }
  },
  {
    "name": "Creamy Shredded Cabbage Coleslaw",
    "kind": "salad",
    "diets": [
      "vegetarian",
      "gluten-free"
    ],
    "yieldPortions": 50,
    "portionSize": "1/2 cup (3 oz)",
    "components": [
      {
        "ingredient": "Green cabbage",
        "category": "vegetable",
        "quantity": 10,
        "unit": "lb",
        "prep": "cored, shredded 1/8 inch"
      },
      {
        "ingredient": "Carrots",
        "category": "vegetable",
        "quantity": 1.5,
        "unit": "lb",
        "prep": "peeled, shredded"
      },
      {
        "ingredient": "Mayonnaise",
        "category": "fat",
        "quantity": 3,
        "unit": "lb",
        "prep": "none"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Cider vinegar",
        "quantity": 8,
        "unit": "fl oz"
      },
      {
        "ingredient": "Granulated sugar",
        "quantity": 8,
        "unit": "oz"
      },
      {
        "ingredient": "Celery seed",
        "quantity": 0.5,
        "unit": "oz"
      },
      {
        "ingredient": "Ground black pepper",
        "quantity": 0.25,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Whisk mayonnaise, vinegar, sugar, celery seed and pepper until the sugar dissolves.",
        "phase": "make_ahead",
        "timeMin": 10
      },
      {
        "order": 1,
        "text": "Combine shredded cabbage and carrot in a large bowl, then fold in the dressing until evenly coated.",
        "phase": "make_ahead",
        "timeMin": 15
      },
      {
        "order": 2,
        "text": "Cover and refrigerate at 41F or below at least 2 hours before service so the cabbage softens and takes the dressing.",
        "phase": "make_ahead",
        "timeMin": 120,
        "criticalTempF": 41
      },
      {
        "order": 3,
        "text": "Stir before portioning with a No. 8 scoop. Keep the service pan on ice; discard after 4 hours at service temperature.",
        "phase": "on_line",
        "timeMin": 15,
        "criticalTempF": 41
      }
    ],
    "nutrition": {
      "kcal": 155,
      "proteinG": 1,
      "fatG": 13,
      "carbG": 9,
      "sodiumMg": 130,
      "potassiumMg": 190,
      "phosphorusMg": 30,
      "sugarG": 7,
      "fluidMl": 0
    }
  },
  {
    "name": "Steamed Brown Rice Pilaf",
    "kind": "starch",
    "diets": [
      "vegan",
      "vegetarian",
      "gluten-free",
      "low-sodium",
      "low-fat",
      "diabetic",
      "lactose-free"
    ],
    "yieldPortions": 50,
    "portionSize": "1/2 cup (4 oz)",
    "components": [
      {
        "ingredient": "Long grain brown rice, dry",
        "category": "starch",
        "quantity": 6,
        "unit": "lb",
        "prep": "rinsed"
      },
      {
        "ingredient": "Yellow onions",
        "category": "vegetable",
        "quantity": 1,
        "unit": "lb",
        "prep": "peeled, small dice"
      },
      {
        "ingredient": "Vegetable oil",
        "category": "fat",
        "quantity": 6,
        "unit": "fl oz",
        "prep": "none"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Low-sodium vegetable broth",
        "quantity": 1.5,
        "unit": "gal"
      },
      {
        "ingredient": "Dried parsley",
        "quantity": 0.5,
        "unit": "oz"
      },
      {
        "ingredient": "Ground black pepper",
        "quantity": 0.25,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Sweat onions in oil 6 minutes, add rice and stir 3 minutes until the grains are coated and lightly toasted.",
        "phase": "make_ahead",
        "timeMin": 10,
        "criticalTempF": 135
      },
      {
        "order": 1,
        "text": "Divide rice mixture between two 12x20x2 pans, 3 lb per pan, and pour 3 qt boiling broth over each. Stir once and level.",
        "phase": "make_ahead",
        "timeMin": 10,
        "criticalTempF": 212
      },
      {
        "order": 2,
        "text": "Cover tightly with foil and bake at 350F for 50-60 minutes until liquid is absorbed and grains are tender.",
        "phase": "make_ahead",
        "timeMin": 60,
        "criticalTempF": 165
      },
      {
        "order": 3,
        "text": "Rest covered 10 minutes, then fluff with a fork and fold in parsley and pepper. Hold covered at 135F or above.",
        "phase": "on_line",
        "criticalTempF": 135
      },
      {
        "order": 4,
        "text": "Portion 1/2 cup with a No. 8 scoop.",
        "phase": "on_line",
        "timeMin": 2
      }
    ],
    "nutrition": {
      "kcal": 215,
      "proteinG": 4,
      "fatG": 5,
      "carbG": 39,
      "sodiumMg": 45,
      "potassiumMg": 150,
      "phosphorusMg": 130,
      "sugarG": 1,
      "fluidMl": 0
    }
  },
  {
    "name": "Whipped Mashed Potatoes",
    "kind": "starch",
    "diets": [
      "vegetarian",
      "gluten-free",
      "low-sodium"
    ],
    "yieldPortions": 50,
    "portionSize": "1/2 cup (4 oz)",
    "components": [
      {
        "ingredient": "Russet potatoes",
        "category": "starch",
        "quantity": 20,
        "unit": "lb",
        "prep": "peeled, cut into 2 inch pieces"
      },
      {
        "ingredient": "Whole milk",
        "category": "dairy",
        "quantity": 2,
        "unit": "qt",
        "prep": "heated to 150F"
      },
      {
        "ingredient": "Unsalted butter",
        "category": "fat",
        "quantity": 1.5,
        "unit": "lb",
        "prep": "cut into cubes, softened"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Ground white pepper",
        "quantity": 0.25,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Cover potatoes with cold water and boil 20-25 minutes until a knife passes through with no resistance.",
        "phase": "on_line",
        "timeMin": 25,
        "criticalTempF": 212
      },
      {
        "order": 1,
        "text": "Drain thoroughly and return to the hot pot for 2 minutes to drive off surface moisture.",
        "phase": "on_line",
        "timeMin": 5,
        "criticalTempF": 135
      },
      {
        "order": 2,
        "text": "Whip in a mixer on low with the paddle, adding butter first, then hot milk in a stream. Stop as soon as it is smooth; overwhipping turns the potatoes gluey.",
        "phase": "on_line",
        "timeMin": 8
      },
      {
        "order": 3,
        "text": "Season with white pepper. Pan, cover, and hold at 135F or above for no more than 2 hours.",
        "phase": "on_line",
        "criticalTempF": 135
      },
      {
        "order": 4,
        "text": "Portion 1/2 cup with a No. 8 scoop.",
        "phase": "on_line",
        "timeMin": 2
      }
    ],
    "nutrition": {
      "kcal": 195,
      "proteinG": 4,
      "fatG": 8,
      "carbG": 28,
      "sodiumMg": 30,
      "potassiumMg": 620,
      "phosphorusMg": 105,
      "sugarG": 2,
      "fluidMl": 0
    }
  },
  {
    "name": "Buttered Egg Noodles with Parsley",
    "kind": "starch",
    "diets": [
      "vegetarian",
      "low-sodium"
    ],
    "yieldPortions": 50,
    "portionSize": "1/2 cup (3 oz)",
    "components": [
      {
        "ingredient": "Wide egg noodles, dry",
        "category": "starch",
        "quantity": 6,
        "unit": "lb",
        "prep": "none"
      },
      {
        "ingredient": "Unsalted butter",
        "category": "fat",
        "quantity": 1,
        "unit": "lb",
        "prep": "melted"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Water",
        "quantity": 5,
        "unit": "gal"
      },
      {
        "ingredient": "Dried parsley",
        "quantity": 0.75,
        "unit": "oz"
      },
      {
        "ingredient": "Ground black pepper",
        "quantity": 0.25,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Add noodles to rapidly boiling water in two batches and cook 7-9 minutes to just tender, stirring to prevent clumping.",
        "phase": "on_line",
        "timeMin": 9,
        "criticalTempF": 212
      },
      {
        "order": 1,
        "text": "Drain immediately in a colander. Do not rinse; the surface starch helps the butter cling.",
        "phase": "on_line",
        "timeMin": 3
      },
      {
        "order": 2,
        "text": "Toss hot noodles with melted butter, parsley and pepper in a 12x20x4 pan.",
        "phase": "on_line",
        "timeMin": 5,
        "criticalTempF": 135
      },
      {
        "order": 3,
        "text": "Cover and hold at 135F or above. Cook in 25-portion batches; noodles held over 45 minutes become pasty.",
        "phase": "on_line",
        "timeMin": 5,
        "criticalTempF": 135
      }
    ],
    "nutrition": {
      "kcal": 210,
      "proteinG": 6,
      "fatG": 8,
      "carbG": 29,
      "sodiumMg": 20,
      "potassiumMg": 85,
      "phosphorusMg": 80,
      "sugarG": 1,
      "fluidMl": 0
    }
  },
  {
    "name": "Steamed Green Beans with Toasted Almonds",
    "kind": "vegetable",
    "diets": [
      "vegetarian",
      "gluten-free",
      "low-sodium",
      "diabetic"
    ],
    "yieldPortions": 50,
    "portionSize": "1/2 cup (3 oz)",
    "components": [
      {
        "ingredient": "Frozen cut green beans",
        "category": "vegetable",
        "quantity": 12,
        "unit": "lb",
        "prep": "none, cook from frozen"
      },
      {
        "ingredient": "Sliced almonds",
        "category": "fat",
        "quantity": 1,
        "unit": "lb",
        "prep": "none"
      },
      {
        "ingredient": "Unsalted butter",
        "category": "fat",
        "quantity": 12,
        "unit": "oz",
        "prep": "melted"
      },
      {
        "ingredient": "Lemon juice",
        "category": "fruit",
        "quantity": 4,
        "unit": "fl oz",
        "prep": "none"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Ground black pepper",
        "quantity": 0.25,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Toast almonds on a sheet pan at 325F for 6-8 minutes until light golden. Watch closely; they burn in under a minute past that point. Reserve at room temperature.",
        "phase": "make_ahead",
        "timeMin": 10,
        "criticalTempF": 325
      },
      {
        "order": 1,
        "text": "Steam green beans in perforated pans, 6 lb per pan, for 6-8 minutes until tender-crisp and bright green.",
        "phase": "on_line",
        "timeMin": 8,
        "criticalTempF": 135
      },
      {
        "order": 2,
        "text": "Transfer to solid pans and toss with melted butter, lemon juice and pepper.",
        "phase": "on_line",
        "timeMin": 5
      },
      {
        "order": 3,
        "text": "Hold covered at 135F or above. Scatter toasted almonds over the top at the moment the pan goes on the line so they stay crisp.",
        "phase": "on_line",
        "criticalTempF": 135
      },
      {
        "order": 4,
        "text": "Portion 1/2 cup with a 4 oz spoodle.",
        "phase": "on_line",
        "timeMin": 2
      }
    ],
    "nutrition": {
      "kcal": 105,
      "proteinG": 3,
      "fatG": 8,
      "carbG": 7,
      "sodiumMg": 15,
      "potassiumMg": 220,
      "phosphorusMg": 60,
      "sugarG": 2,
      "fluidMl": 0
    }
  },
  {
    "name": "Roasted Carrot Coins with Thyme",
    "kind": "vegetable",
    "diets": [
      "vegan",
      "vegetarian",
      "gluten-free",
      "low-sodium",
      "low-fat",
      "diabetic",
      "lactose-free"
    ],
    "yieldPortions": 50,
    "portionSize": "1/2 cup (3 oz)",
    "components": [
      {
        "ingredient": "Carrots",
        "category": "vegetable",
        "quantity": 14,
        "unit": "lb",
        "prep": "peeled, sliced into 1/2 inch coins"
      },
      {
        "ingredient": "Vegetable oil",
        "category": "fat",
        "quantity": 8,
        "unit": "fl oz",
        "prep": "none"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Dried thyme",
        "quantity": 0.5,
        "unit": "oz"
      },
      {
        "ingredient": "Granulated garlic",
        "quantity": 0.5,
        "unit": "oz"
      },
      {
        "ingredient": "Ground black pepper",
        "quantity": 0.25,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Toss carrot coins with oil, thyme, garlic and pepper until evenly coated.",
        "phase": "make_ahead",
        "timeMin": 15
      },
      {
        "order": 1,
        "text": "Spread in a single layer on sheet pans, about 3.5 lb per full sheet. Crowded pans trap moisture and the coins never caramelize.",
        "phase": "on_line",
        "timeMin": 10
      },
      {
        "order": 2,
        "text": "Roast at 425F convection for 20-25 minutes, turning once at the halfway point, until edges are caramelized and a coin yields easily to a fork.",
        "phase": "on_line",
        "timeMin": 25,
        "criticalTempF": 135
      },
      {
        "order": 3,
        "text": "Pan and hold covered at 135F or above for no more than 90 minutes; longer holding softens the roasted edges.",
        "phase": "on_line",
        "criticalTempF": 135
      },
      {
        "order": 4,
        "text": "Portion 1/2 cup with a 4 oz spoodle.",
        "phase": "on_line",
        "timeMin": 2
      }
    ],
    "nutrition": {
      "kcal": 85,
      "proteinG": 1,
      "fatG": 5,
      "carbG": 10,
      "sodiumMg": 70,
      "potassiumMg": 300,
      "phosphorusMg": 35,
      "sugarG": 5,
      "fluidMl": 0
    }
  },
  {
    "name": "Braised Collard Greens with Onion",
    "kind": "vegetable",
    "diets": [
      "vegan",
      "vegetarian",
      "gluten-free",
      "low-sodium",
      "low-fat",
      "diabetic",
      "lactose-free"
    ],
    "yieldPortions": 50,
    "portionSize": "1/2 cup (3 oz)",
    "components": [
      {
        "ingredient": "Collard greens",
        "category": "vegetable",
        "quantity": 14,
        "unit": "lb",
        "prep": "stems removed, washed three times, cut into 1 inch ribbons"
      },
      {
        "ingredient": "Yellow onions",
        "category": "vegetable",
        "quantity": 2,
        "unit": "lb",
        "prep": "peeled, sliced thin"
      },
      {
        "ingredient": "Vegetable oil",
        "category": "fat",
        "quantity": 8,
        "unit": "fl oz",
        "prep": "none"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Low-sodium vegetable broth",
        "quantity": 2,
        "unit": "qt"
      },
      {
        "ingredient": "Cider vinegar",
        "quantity": 8,
        "unit": "fl oz"
      },
      {
        "ingredient": "Smoked paprika",
        "quantity": 1,
        "unit": "oz"
      },
      {
        "ingredient": "Ground black pepper",
        "quantity": 0.25,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Wash greens in three changes of cold water; grit settles and the leaves must be lifted out, not poured off.",
        "phase": "make_ahead",
        "timeMin": 30
      },
      {
        "order": 1,
        "text": "Sweat onions in oil in a tilt skillet 8 minutes until soft, then add smoked paprika and stir 1 minute to bloom it.",
        "phase": "make_ahead",
        "timeMin": 10,
        "criticalTempF": 135
      },
      {
        "order": 2,
        "text": "Add greens in batches with the broth, cover, and braise at low heat 40-50 minutes until fully tender.",
        "phase": "make_ahead",
        "timeMin": 50,
        "criticalTempF": 165
      },
      {
        "order": 3,
        "text": "Finish with cider vinegar and black pepper. Hold covered at 135F or above.",
        "phase": "on_line",
        "criticalTempF": 135
      },
      {
        "order": 4,
        "text": "Portion 1/2 cup with a 4 oz spoodle, lifting from the bottom so each serving carries some pot liquor.",
        "phase": "on_line",
        "timeMin": 2
      }
    ],
    "nutrition": {
      "kcal": 90,
      "proteinG": 3,
      "fatG": 5,
      "carbG": 8,
      "sodiumMg": 45,
      "potassiumMg": 250,
      "phosphorusMg": 55,
      "sugarG": 1,
      "fluidMl": 0
    }
  },
  {
    "name": "Baked Cornbread Square",
    "kind": "side",
    "diets": [
      "vegetarian"
    ],
    "yieldPortions": 50,
    "portionSize": "1 square (2.5 oz)",
    "components": [
      {
        "ingredient": "Yellow cornmeal",
        "category": "starch",
        "quantity": 4,
        "unit": "lb",
        "prep": "none"
      },
      {
        "ingredient": "All-purpose flour",
        "category": "starch",
        "quantity": 3,
        "unit": "lb",
        "prep": "none"
      },
      {
        "ingredient": "Whole milk",
        "category": "dairy",
        "quantity": 3,
        "unit": "qt",
        "prep": "room temperature"
      },
      {
        "ingredient": "Whole eggs",
        "category": "protein",
        "quantity": 12,
        "unit": "each",
        "prep": "beaten"
      },
      {
        "ingredient": "Vegetable oil",
        "category": "fat",
        "quantity": 16,
        "unit": "fl oz",
        "prep": "none"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Granulated sugar",
        "quantity": 1,
        "unit": "lb"
      },
      {
        "ingredient": "Baking powder",
        "quantity": 5,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Whisk cornmeal, flour, sugar and baking powder together in a mixer bowl.",
        "phase": "make_ahead",
        "timeMin": 5
      },
      {
        "order": 1,
        "text": "Combine milk, eggs and oil separately, then add to the dry ingredients and mix on low just until moistened, about 30 seconds. Overmixing makes the crumb tough.",
        "phase": "make_ahead",
        "timeMin": 5
      },
      {
        "order": 2,
        "text": "Divide batter between two greased 12x20x2 pans and bake immediately at 375F for 25-30 minutes until a tester comes out clean and the center reads 200F.",
        "phase": "make_ahead",
        "timeMin": 30,
        "criticalTempF": 200
      },
      {
        "order": 3,
        "text": "Cool 15 minutes, then cut each pan 5x5 into 25 squares. Serve warm, or hold covered at 70F or below for same-day service.",
        "phase": "on_line",
        "timeMin": 20,
        "criticalTempF": 70
      }
    ],
    "nutrition": {
      "kcal": 235,
      "proteinG": 6,
      "fatG": 9,
      "carbG": 33,
      "sodiumMg": 290,
      "potassiumMg": 110,
      "phosphorusMg": 245,
      "sugarG": 10,
      "fluidMl": 0
    }
  },
  {
    "name": "Warm Cinnamon Applesauce",
    "kind": "side",
    "diets": [
      "vegan",
      "vegetarian",
      "gluten-free",
      "low-sodium",
      "renal",
      "low-fat",
      "diabetic",
      "lactose-free"
    ],
    "yieldPortions": 50,
    "portionSize": "1/2 cup (4 oz)",
    "components": [
      {
        "ingredient": "Unsweetened applesauce, canned",
        "category": "fruit",
        "quantity": 13,
        "unit": "lb",
        "prep": "none"
      },
      {
        "ingredient": "Lemon juice",
        "category": "fruit",
        "quantity": 2,
        "unit": "fl oz",
        "prep": "none"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Ground cinnamon",
        "quantity": 1,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Combine applesauce, cinnamon and lemon juice in a jacketed kettle or 12x20x4 pan and stir until the cinnamon is fully dispersed with no dry streaks.",
        "phase": "on_line",
        "timeMin": 8
      },
      {
        "order": 1,
        "text": "Heat to 165F, stirring every 5 minutes to prevent scorching on the bottom.",
        "phase": "on_line",
        "timeMin": 20,
        "criticalTempF": 165
      },
      {
        "order": 2,
        "text": "Check the surface for skin and stir it back in before panning.",
        "phase": "on_line",
        "timeMin": 2
      },
      {
        "order": 3,
        "text": "Hold covered at 135F or above and portion with a No. 8 scoop. Suits renal trays: apple is low in potassium and phosphorus.",
        "phase": "on_line",
        "criticalTempF": 135
      }
    ],
    "nutrition": {
      "kcal": 60,
      "proteinG": 0,
      "fatG": 0,
      "carbG": 15,
      "sodiumMg": 5,
      "potassiumMg": 90,
      "phosphorusMg": 10,
      "sugarG": 12,
      "fluidMl": 90
    }
  },
  {
    "name": "Baked Apple Crisp",
    "kind": "dessert",
    "diets": [
      "vegetarian"
    ],
    "yieldPortions": 48,
    "portionSize": "1 piece (4 oz)",
    "components": [
      {
        "ingredient": "Sliced apples, canned or IQF",
        "category": "fruit",
        "quantity": 18,
        "unit": "lb",
        "prep": "drained"
      },
      {
        "ingredient": "Rolled oats",
        "category": "starch",
        "quantity": 3,
        "unit": "lb",
        "prep": "none"
      },
      {
        "ingredient": "All-purpose flour",
        "category": "starch",
        "quantity": 2,
        "unit": "lb",
        "prep": "none"
      },
      {
        "ingredient": "Unsalted butter",
        "category": "fat",
        "quantity": 2.5,
        "unit": "lb",
        "prep": "cold, cut into 1/2 inch cubes"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Granulated sugar",
        "quantity": 2,
        "unit": "lb"
      },
      {
        "ingredient": "Ground cinnamon",
        "quantity": 1,
        "unit": "oz"
      },
      {
        "ingredient": "Brown sugar",
        "quantity": 2,
        "unit": "lb"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Toss apples with granulated sugar and cinnamon. Divide between two greased 12x20x2 pans and level.",
        "phase": "make_ahead",
        "timeMin": 20
      },
      {
        "order": 1,
        "text": "Cut cold butter into the oats, flour and brown sugar with a paddle on low until the mixture forms pea-sized crumbs. Stop before it becomes a paste or the topping melts flat.",
        "phase": "make_ahead",
        "timeMin": 10
      },
      {
        "order": 2,
        "text": "Scatter half the topping evenly over each pan without pressing it down.",
        "phase": "make_ahead",
        "timeMin": 10
      },
      {
        "order": 3,
        "text": "Bake at 350F for 40-45 minutes until the topping is golden, the fruit bubbles at the edges, and the center reads 200F.",
        "phase": "make_ahead",
        "timeMin": 45,
        "criticalTempF": 200
      },
      {
        "order": 4,
        "text": "Rest 30 minutes before cutting each pan 4x6 into 24 portions. Serve warm or at room temperature.",
        "phase": "on_line",
        "timeMin": 35,
        "criticalTempF": 70
      }
    ],
    "nutrition": {
      "kcal": 330,
      "proteinG": 3,
      "fatG": 13,
      "carbG": 52,
      "sodiumMg": 15,
      "potassiumMg": 150,
      "phosphorusMg": 85,
      "sugarG": 33,
      "fluidMl": 0
    }
  },
  {
    "name": "Baked Vanilla Rice Pudding",
    "kind": "dessert",
    "diets": [
      "vegetarian",
      "gluten-free",
      "low-sodium"
    ],
    "yieldPortions": 50,
    "portionSize": "1/2 cup (4 oz)",
    "components": [
      {
        "ingredient": "Cooked long grain white rice",
        "category": "starch",
        "quantity": 6,
        "unit": "lb",
        "prep": "cooled"
      },
      {
        "ingredient": "Whole milk",
        "category": "dairy",
        "quantity": 2.5,
        "unit": "gal",
        "prep": "none"
      },
      {
        "ingredient": "Whole eggs",
        "category": "protein",
        "quantity": 12,
        "unit": "each",
        "prep": "beaten"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Granulated sugar",
        "quantity": 2,
        "unit": "lb"
      },
      {
        "ingredient": "Vanilla extract",
        "quantity": 4,
        "unit": "fl oz"
      },
      {
        "ingredient": "Ground nutmeg",
        "quantity": 0.25,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Scald milk with sugar to 160F, stirring until the sugar dissolves.",
        "phase": "make_ahead",
        "timeMin": 15,
        "criticalTempF": 160
      },
      {
        "order": 1,
        "text": "Temper the beaten eggs with 1 qt of the hot milk in a stream while whisking, then return the mixture to the pot. Adding eggs directly will scramble them.",
        "phase": "make_ahead",
        "timeMin": 10,
        "criticalTempF": 160
      },
      {
        "order": 2,
        "text": "Stir in the prepared rice and vanilla and divide between two greased 12x20x2 pans. Dust the surface with nutmeg.",
        "phase": "make_ahead",
        "timeMin": 10
      },
      {
        "order": 3,
        "text": "Bake in a water bath at 325F for 45-55 minutes until the custard reaches 160F and the center barely jiggles.",
        "phase": "make_ahead",
        "timeMin": 55,
        "criticalTempF": 160
      },
      {
        "order": 4,
        "text": "Cool to 41F within 6 hours in shallow pans. Portion with a No. 8 scoop and serve chilled or warmed to 135F.",
        "phase": "on_line",
        "timeMin": 20,
        "criticalTempF": 41
      }
    ],
    "nutrition": {
      "kcal": 245,
      "proteinG": 8,
      "fatG": 6,
      "carbG": 39,
      "sodiumMg": 95,
      "potassiumMg": 280,
      "phosphorusMg": 195,
      "sugarG": 26,
      "fluidMl": 90
    }
  },
  {
    "name": "Chilled Peach Gelatin Cup",
    "kind": "dessert",
    "diets": [
      "gluten-free",
      "low-sodium",
      "renal",
      "low-fat",
      "lactose-free"
    ],
    "yieldPortions": 50,
    "portionSize": "1/2 cup (4 fl oz)",
    "components": [
      {
        "ingredient": "Diced peaches in juice, canned",
        "category": "fruit",
        "quantity": 6,
        "unit": "lb",
        "prep": "drained well"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Peach-flavored gelatin dessert powder",
        "quantity": 24,
        "unit": "oz"
      },
      {
        "ingredient": "Boiling water",
        "quantity": 1.5,
        "unit": "gal"
      },
      {
        "ingredient": "Cold water",
        "quantity": 1.5,
        "unit": "gal"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Dissolve the gelatin powder completely in the boiling water, whisking 3 minutes. Undissolved granules will not set.",
        "phase": "make_ahead",
        "timeMin": 5,
        "criticalTempF": 212
      },
      {
        "order": 1,
        "text": "Stir in the cold water and refrigerate 45-60 minutes until the mixture thickens to raw egg white consistency.",
        "phase": "make_ahead",
        "timeMin": 60,
        "criticalTempF": 41
      },
      {
        "order": 2,
        "text": "Fold in drained peaches. Folding at this stage keeps the fruit suspended rather than sinking to the bottom.",
        "phase": "make_ahead",
        "timeMin": 10
      },
      {
        "order": 3,
        "text": "Portion 4 fl oz into 50 individual cups, cover, and refrigerate at least 4 hours until fully set.",
        "phase": "make_ahead",
        "timeMin": 240,
        "criticalTempF": 41
      },
      {
        "order": 4,
        "text": "Hold and serve at 41F or below. Counts as 120 ml toward fluid intake on fluid-restricted trays.",
        "phase": "on_line",
        "criticalTempF": 41
      }
    ],
    "nutrition": {
      "kcal": 105,
      "proteinG": 2,
      "fatG": 0,
      "carbG": 25,
      "sodiumMg": 55,
      "potassiumMg": 75,
      "phosphorusMg": 15,
      "sugarG": 24,
      "fluidMl": 120
    }
  },
  {
    "name": "Blended Fortified Vanilla Milkshake",
    "kind": "beverage",
    "diets": [
      "vegetarian",
      "gluten-free"
    ],
    "yieldPortions": 25,
    "portionSize": "8 fl oz",
    "components": [
      {
        "ingredient": "Whole milk",
        "category": "dairy",
        "quantity": 1,
        "unit": "gal",
        "prep": "chilled to 41F"
      },
      {
        "ingredient": "Vanilla ice cream",
        "category": "dairy",
        "quantity": 1,
        "unit": "gal",
        "prep": "tempered 10 minutes"
      },
      {
        "ingredient": "Nonfat dry milk powder",
        "category": "dairy",
        "quantity": 12,
        "unit": "oz",
        "prep": "none"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Vanilla extract",
        "quantity": 2,
        "unit": "fl oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Whisk the dry milk powder into the cold milk until fully dissolved with no lumps. This is the fortification step that raises protein and calories for weight-loss residents.",
        "phase": "make_ahead",
        "timeMin": 8
      },
      {
        "order": 1,
        "text": "Chill the fortified milk and the serving cups to 41F or below until service.",
        "phase": "make_ahead",
        "timeMin": 60,
        "criticalTempF": 41
      },
      {
        "order": 2,
        "text": "Blend the fortified milk, ice cream and vanilla in batches of 5 portions on medium for 30 seconds until smooth.",
        "phase": "on_line",
        "timeMin": 10
      },
      {
        "order": 3,
        "text": "Portion 8 fl oz into chilled cups and serve within 15 minutes. Blend to order; the shake separates on holding.",
        "phase": "on_line",
        "timeMin": 10,
        "criticalTempF": 41
      }
    ],
    "nutrition": {
      "kcal": 330,
      "proteinG": 13,
      "fatG": 14,
      "carbG": 39,
      "sodiumMg": 195,
      "potassiumMg": 545,
      "phosphorusMg": 340,
      "sugarG": 35,
      "fluidMl": 240
    }
  },
  {
    "name": "Brewed Unsweetened Iced Tea with Lemon",
    "kind": "beverage",
    "diets": [
      "vegan",
      "vegetarian",
      "gluten-free",
      "low-sodium",
      "renal",
      "low-fat",
      "diabetic",
      "lactose-free"
    ],
    "yieldPortions": 50,
    "portionSize": "8 fl oz",
    "components": [
      {
        "ingredient": "Lemons",
        "category": "fruit",
        "quantity": 4,
        "unit": "lb",
        "prep": "washed, cut into 50 wedges"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Black tea bags, 1 oz each",
        "quantity": 20,
        "unit": "each"
      },
      {
        "ingredient": "Hot water",
        "quantity": 1.5,
        "unit": "gal"
      },
      {
        "ingredient": "Cold water",
        "quantity": 2,
        "unit": "gal"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Steep the tea bags in the 200F water for 5 minutes, then lift them out without squeezing. Squeezing releases tannin and turns the tea bitter.",
        "phase": "make_ahead",
        "timeMin": 8,
        "criticalTempF": 200
      },
      {
        "order": 1,
        "text": "Add the cold water to the concentrate and stir. Chill to 41F or below within 4 hours.",
        "phase": "make_ahead",
        "timeMin": 240,
        "criticalTempF": 41
      },
      {
        "order": 2,
        "text": "Hold in covered beverage urns at 41F or below and discard any tea held more than 24 hours.",
        "phase": "on_line",
        "criticalTempF": 41
      },
      {
        "order": 3,
        "text": "Pour 8 fl oz over ice and garnish each glass with one lemon wedge at service.",
        "phase": "on_line",
        "timeMin": 15
      }
    ],
    "nutrition": {
      "kcal": 5,
      "proteinG": 0,
      "fatG": 0,
      "carbG": 1,
      "sodiumMg": 5,
      "potassiumMg": 60,
      "phosphorusMg": 5,
      "sugarG": 0,
      "fluidMl": 240
    }
  },
  {
    "name": "Chilled Deviled Egg Halves",
    "kind": "appetizer",
    "diets": [
      "vegetarian",
      "gluten-free",
      "low-sodium",
      "diabetic",
      "lactose-free"
    ],
    "yieldPortions": 50,
    "portionSize": "2 halves",
    "components": [
      {
        "ingredient": "Large eggs",
        "category": "protein",
        "quantity": 50,
        "unit": "each",
        "prep": "hard cooked, peeled, chilled"
      },
      {
        "ingredient": "Mayonnaise",
        "category": "fat",
        "quantity": 1.5,
        "unit": "lb",
        "prep": "none"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Yellow mustard",
        "quantity": 4,
        "unit": "oz"
      },
      {
        "ingredient": "Cider vinegar",
        "quantity": 1,
        "unit": "fl oz"
      },
      {
        "ingredient": "Paprika",
        "quantity": 0.5,
        "unit": "oz"
      },
      {
        "ingredient": "Ground black pepper",
        "quantity": 0.25,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Hard cook eggs, cool immediately in ice water, and peel. Chill to 41F or below before handling.",
        "phase": "make_ahead",
        "timeMin": 45,
        "criticalTempF": 41
      },
      {
        "order": 1,
        "text": "Halve the eggs lengthwise and pop the yolks into a mixer bowl, keeping the whites in a single layer on a lined sheet pan.",
        "phase": "make_ahead",
        "timeMin": 25
      },
      {
        "order": 2,
        "text": "Mash yolks with mayonnaise, mustard, vinegar and pepper on low until smooth.",
        "phase": "make_ahead",
        "timeMin": 8
      },
      {
        "order": 3,
        "text": "Pipe or scoop the filling into the 100 whites, dust with paprika, cover, and refrigerate at 41F or below.",
        "phase": "make_ahead",
        "timeMin": 30,
        "criticalTempF": 41
      },
      {
        "order": 4,
        "text": "Serve 2 halves per portion on a chilled plate. Discard any tray held out of refrigeration over 4 hours.",
        "phase": "on_line",
        "timeMin": 10,
        "criticalTempF": 41
      }
    ],
    "nutrition": {
      "kcal": 165,
      "proteinG": 7,
      "fatG": 14,
      "carbG": 1,
      "sodiumMg": 190,
      "potassiumMg": 75,
      "phosphorusMg": 105,
      "sugarG": 0,
      "fluidMl": 0
    }
  },
  {
    "name": "Baked Stuffed Mushroom Caps",
    "kind": "appetizer",
    "diets": [
      "vegetarian"
    ],
    "yieldPortions": 50,
    "portionSize": "3 caps",
    "components": [
      {
        "ingredient": "White button mushrooms, 1.5 inch caps",
        "category": "vegetable",
        "quantity": 13,
        "unit": "lb",
        "prep": "washed, stems removed and reserved, 150 caps total"
      },
      {
        "ingredient": "Dry breadcrumbs",
        "category": "starch",
        "quantity": 2,
        "unit": "lb",
        "prep": "none"
      },
      {
        "ingredient": "Grated parmesan cheese",
        "category": "dairy",
        "quantity": 1,
        "unit": "lb",
        "prep": "none"
      },
      {
        "ingredient": "Yellow onions",
        "category": "vegetable",
        "quantity": 1,
        "unit": "lb",
        "prep": "peeled, minced"
      },
      {
        "ingredient": "Olive oil",
        "category": "fat",
        "quantity": 12,
        "unit": "fl oz",
        "prep": "none"
      }
    ],
    "seasonings": [
      {
        "ingredient": "Granulated garlic",
        "quantity": 0.5,
        "unit": "oz"
      },
      {
        "ingredient": "Dried parsley",
        "quantity": 0.75,
        "unit": "oz"
      }
    ],
    "method": [
      {
        "order": 0,
        "text": "Mince the reserved mushroom stems and sweat with the onions in 6 fl oz of the oil for 10 minutes until dry.",
        "phase": "make_ahead",
        "timeMin": 12
      },
      {
        "order": 1,
        "text": "Combine the sweated stem mixture with breadcrumbs, parmesan, garlic and parsley to form a moist stuffing.",
        "phase": "make_ahead",
        "timeMin": 10
      },
      {
        "order": 2,
        "text": "Fill each cap with about 0.5 oz stuffing, mounded. Arrange 50 caps per sheet pan and drizzle with the remaining oil.",
        "phase": "make_ahead",
        "timeMin": 35
      },
      {
        "order": 3,
        "text": "Bake at 375F for 15-18 minutes until the tops are golden and the filling reaches 165F.",
        "phase": "on_line",
        "timeMin": 18,
        "criticalTempF": 165
      },
      {
        "order": 4,
        "text": "Hold uncovered under a heat lamp at 135F or above for up to 30 minutes; covering makes the tops soggy. Serve 3 caps per portion.",
        "phase": "on_line",
        "criticalTempF": 135
      }
    ],
    "nutrition": {
      "kcal": 160,
      "proteinG": 8,
      "fatG": 9,
      "carbG": 13,
      "sodiumMg": 285,
      "potassiumMg": 390,
      "phosphorusMg": 160,
      "sugarG": 2,
      "fluidMl": 0
    }
  }
];
