import mongoose from "mongoose";

const workoutStrengthSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },
    date: { type: Date, default: Date.now },
    routineType: { type: String, required: [true, "Routine type is required"] },
    // Plan markers. Optional, and null for every session logged by a client that predates them.
    //
    // Without these a completed session is just a dated row: the coach hydrator has to GUESS
    // which planned day it was by counting how many sessions exist in the current week. With
    // them the link is exact, which is what lets the coach say what is left this week instead of
    // inferring it. `dayIndex` is the position within `weeks[].days`, matching the client's
    // workout_execution/{weekNumber}/{dayIndex} route.
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkoutPlan",
      default: null,
    },
    weekNumber: { type: Number, default: null, min: 1 },
    dayIndex: { type: Number, default: null, min: 0 },
    exercises: [
      {
        exerciseName: { type: String, required: true },
        sets: { type: Number, required: true },
        reps: { type: Number, required: true },
        targetWeight: { type: Number, required: true },
        actualWeight: { type: Number },
        targetRpe: { type: Number, required: true, min: 1, max: 10 },
        actualRpe: { type: Number, min: 1, max: 10 },
      },
    ],
  },
  { timestamps: true },
);

export default mongoose.model("WorkoutStrength", workoutStrengthSchema);
