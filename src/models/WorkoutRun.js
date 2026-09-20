import mongoose from "mongoose";

const workoutRunSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },
    date: { type: Date, default: Date.now },
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
    distance: { type: Number, required: [true, "Distance is required"] },
    duration: { type: Number, required: [true, "Duration is required"] },

    // Pace stored strictly in total seconds per kilometer (e.g., 330 for 05:30 min/km)
    targetPace: {
      type: Number,
      required: true,
    },
    actualPace: {
      type: Number,
    },
    elevationGain: { type: Number, default: 0 },
    gpsPath: [
      {
        lat: { type: Number },
        lng: { type: Number },
      },
    ],
    rpe: { type: Number, min: 1, max: 10 },
  },
  { timestamps: true },
);

export default mongoose.model("WorkoutRun", workoutRunSchema);
