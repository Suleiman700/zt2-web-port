// Zoo fame, as computed by the original's scripts/ZooFame.bin (compiled Lua, read with
// tools/luadis.mjs): adjustZooFame runs each time a guest leaves the zoo (guest.tsk sends
// "Adjust_ZooFame"). Each part may only move a limited step from its previous value per update,
// so fame changes gradually. Points 1..100 give 1..10 half stars; the front gate model grows
// with them.

const NUM_ANIMAL_WEIGHT = 10, MAX_NUM_ANIMAL = 35, MAX_NUM_ANIMAL_DELTA = 30;
const NUM_SPECIES_WEIGHT = 40, MAX_NUM_SPECIES = 20, MAX_NUM_SPECIES_DELTA = 40;
const MAX_ANIMAL_HAPPINESS = 70, MAX_ANIMAL_HAPPINESS_DELTA = 6;
const MAX_GUEST_HAPPINESS = 80, MAX_GUEST_HAPPINESS_DELTA = 6;
const MAX_EDUCATION = 6, EDUCATION_WEIGHT = 15, MAX_EDUCATION_DELTA = 0.5;
const MAX_ENTERTAINMENT = 50, ENTERTAINMENT_WEIGHT = 20, MAX_ENTERTAINMENT_DELTA = 2;
const MAX_GOAL_POINTS = 8, GOAL_POINTS_WEIGHT = 15;
const MAX_RELEASE_WILD = 10, RELEASE_WILD_WEIGHT = 15;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function newFameState() {
  return {
    currentNumAnimalFame: 0, currentNumSpeciesFame: 0, averageAnimalHappiness: 0,
    currentEducationFame: 0, currentEntertainmentFame: 0, averageGuestHappiness: 0,
    awardPoints: 0, scenarioPoints: 0, currentHalfStars: 1,
  };
}

// input: {
//   animals: [{ species, needPointsGood }],          // f_needPointsGood per animal
//   guests: [{ happiness, education }],               // guests in the zoo (happiness, f_Education)
//   speciesSeen: [{ viewEvents, entertain, donate }], // guests' viewing data per species
//   animalsReleased,                                  // released to the wild so far
// }
// Updates `state` and returns { points, halfStars, bars } (bars: each part's value and maximum).
export function adjustZooFame(state, input) {
  const animals = input.animals ?? [], guests = input.guests ?? [];
  const nAnimals = clamp(animals.length, 0, MAX_NUM_ANIMAL);
  const nSpecies = clamp(new Set(animals.map((a) => a.species)).size, 0, MAX_NUM_SPECIES);
  const avg = (list, key) => (list.length ? list.reduce((s, x) => s + (x[key] ?? 0), 0) / list.length : 0);

  const animalFame = clamp(nAnimals * NUM_ANIMAL_WEIGHT / MAX_NUM_ANIMAL,
    state.currentNumAnimalFame - MAX_NUM_ANIMAL_DELTA, state.currentNumAnimalFame + MAX_NUM_ANIMAL_DELTA);
  state.currentNumAnimalFame = animalFame;
  const speciesFame = clamp(nSpecies * NUM_SPECIES_WEIGHT / MAX_NUM_SPECIES,
    state.currentNumSpeciesFame - MAX_NUM_SPECIES_DELTA, state.currentNumSpeciesFame + MAX_NUM_SPECIES_DELTA);
  state.currentNumSpeciesFame = speciesFame;
  const animalHappiness = clamp(avg(animals, 'needPointsGood'),
    state.averageAnimalHappiness - MAX_ANIMAL_HAPPINESS_DELTA, state.averageAnimalHappiness + MAX_ANIMAL_HAPPINESS_DELTA);
  state.averageAnimalHappiness = animalHappiness;
  const animalTotal = (animalFame + speciesFame) * animalHappiness / MAX_ANIMAL_HAPPINESS;

  // The script takes 100 minus the guests' average "happiness" attribute (to be matched with the
  // guest AI's meaning of that attribute in Phase 5).
  let guestHappiness = guests.length ? 100 - avg(guests, 'happiness') : 0;
  let viewEvents = 0, entertain = 0;
  for (const s of input.speciesSeen ?? []) { viewEvents += s.viewEvents ?? 0; entertain += s.entertain ?? 0; }
  const education = avg(guests, 'education') * guests.length;
  const educationPerView = viewEvents ? clamp(education / viewEvents, 0, MAX_EDUCATION) : 0;
  const entertainmentPerView = viewEvents ? clamp(entertain / viewEvents, 0, MAX_ENTERTAINMENT) : 0;
  const educationFame = clamp(educationPerView * EDUCATION_WEIGHT / MAX_EDUCATION,
    state.currentEducationFame - MAX_EDUCATION_DELTA, state.currentEducationFame + MAX_EDUCATION_DELTA);
  state.currentEducationFame = educationFame;
  const entertainmentFame = clamp(entertainmentPerView * ENTERTAINMENT_WEIGHT / MAX_ENTERTAINMENT,
    state.currentEntertainmentFame - MAX_ENTERTAINMENT_DELTA, state.currentEntertainmentFame + MAX_ENTERTAINMENT_DELTA);
  state.currentEntertainmentFame = entertainmentFame;
  guestHappiness = clamp(guestHappiness, state.averageGuestHappiness - MAX_GUEST_HAPPINESS_DELTA, state.averageGuestHappiness + MAX_GUEST_HAPPINESS_DELTA);
  state.averageGuestHappiness = guestHappiness;
  const guestTotal = (educationFame + entertainmentFame) * guestHappiness / MAX_GUEST_HAPPINESS;

  const goals = clamp(state.awardPoints + state.scenarioPoints, 0, MAX_GOAL_POINTS) * GOAL_POINTS_WEIGHT / MAX_GOAL_POINTS;
  const released = clamp(input.animalsReleased ?? 0, 0, MAX_RELEASE_WILD) * RELEASE_WILD_WEIGHT / MAX_RELEASE_WILD;

  const points = clamp(animalTotal + guestTotal + goals + released, 1, 100);
  const halfStars = Math.floor(clamp(points / 10, 1, 10));
  state.currentHalfStars = halfStars;
  return {
    points, halfStars,
    bars: {
      'animal quantity': [animalFame, NUM_ANIMAL_WEIGHT], 'animal variety': [speciesFame, NUM_SPECIES_WEIGHT],
      'animal happiness': [animalHappiness, MAX_ANIMAL_HAPPINESS], 'guest education': [educationFame, EDUCATION_WEIGHT],
      'guest entertainment': [entertainmentFame, ENTERTAINMENT_WEIGHT], 'guest happiness': [guestHappiness, MAX_GUEST_HAPPINESS],
      'award bonus': [goals, GOAL_POINTS_WEIGHT], 'release to wild bonus': [released, RELEASE_WILD_WEIGHT],
    },
  };
}

// Front gate model for a number of half stars (setFamePoints in ZooFame.bin).
export function frontGateFor(halfStars) {
  if (halfStars <= 3) return 'frontgate_df';
  if (halfStars <= 5) return 'frontgate_fame02';
  if (halfStars <= 7) return 'frontgate_fame03';
  if (halfStars <= 9) return 'frontgate_fame04';
  return 'frontgate_fame05';
}
