// Meal-type identity: one color per slot, like Skylight (Breakfast / Lunch /
// Dinner / Snack). Shared by the Meals grid + its filter.
export interface MealType {
  key: string;
  label: string;
  color: string;
  tint: string;
}
export const MEAL_TYPES: MealType[] = [
  { key: "breakfast", label: "Breakfast", color: "#DE7C5A", tint: "rgba(222,124,90,0.15)" },
  { key: "lunch", label: "Lunch", color: "#7FA576", tint: "rgba(127,165,118,0.15)" },
  { key: "dinner", label: "Dinner", color: "#D9A254", tint: "rgba(217,162,84,0.15)" },
  { key: "snack", label: "Snack", color: "#8A6D9E", tint: "rgba(138,109,158,0.15)" },
];
export const MEAL_TYPE_KEYS = MEAL_TYPES.map((m) => m.key);
