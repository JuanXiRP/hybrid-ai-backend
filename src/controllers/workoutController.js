import WorkoutStrength from "../models/WorkoutStrength.js";
import WorkoutRun from "../models/WorkoutRun.js";

// @desc    Create a new strength workout record
// @route   POST /api/workouts/strength
// @access  Private
export const createStrengthWorkout = async (req, res) => {
  try {
    // Inject the verified user ID from the JWT payload
    const payload = {
      ...req.body,
      userId: req.user._id,
    };

    const workout = await WorkoutStrength.create(payload);

    res.status(201).json({
      success: true,
      data: workout,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// Any UUID version: the client mints them, and the app's own migration backfills v4-shaped ones.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The only body fields a client may write. `userId` comes from the JWT and `clientId` from the
// path; `planId` is not accepted at all, so a client cannot attach a log to someone else's plan.
const UPSERTABLE_STRENGTH_FIELDS = [
  "routineType",
  "date",
  "startedAt",
  "durationSec",
  "notes",
  "weekNumber",
  "dayIndex",
  "exercises",
];

const DUPLICATE_KEY_ERROR = 11000;

const pickAllowed = (body, fields) =>
  Object.fromEntries(
    fields
      .filter((field) => body?.[field] !== undefined)
      .map((field) => [field, body[field]]),
  );

// @desc    Create or replace a strength workout record, keyed by a client-generated id
// @route   PUT /api/workouts/strength/:clientId
// @access  Private
export const upsertStrengthWorkout = async (req, res) => {
  const { clientId } = req.params;

  if (!UUID_PATTERN.test(clientId)) {
    return res.status(400).json({
      success: false,
      message: "clientId must be a UUID",
    });
  }

  try {
    const userId = req.user._id;
    const fields = pickAllowed(req.body, UPSERTABLE_STRENGTH_FIELDS);

    // An update validator only sees the paths being $set, so a missing `routineType` would slip
    // through and create a document the POST route would have refused. Validating a full document
    // first keeps both routes' rules identical.
    await new WorkoutStrength({ ...fields, userId, clientId }).validate();

    const write = () =>
      WorkoutStrength.findOneAndUpdate(
        { userId, clientId },
        { $set: fields, $setOnInsert: { userId, clientId } },
        {
          upsert: true,
          new: true,
          runValidators: true,
          setDefaultsOnInsert: true,
        },
      );

    let workout;
    try {
      workout = await write();
    } catch (error) {
      // Two concurrent first PUTs for one clientId (a retry racing its original) both miss the
      // find and both try to insert; the unique index rejects the loser. By now the winner's
      // document exists, so running the same upsert again takes the update path.
      if (error.code !== DUPLICATE_KEY_ERROR) throw error;
      workout = await write();
    }

    res.status(200).json({
      success: true,
      data: workout,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// @desc    Create a new run workout record
// @route   POST /api/workouts/run
// @access  Private
export const createRunWorkout = async (req, res) => {
  try {
    // Inject the verified user ID from the JWT payload
    const payload = {
      ...req.body,
      userId: req.user._id,
    };

    const workout = await WorkoutRun.create(payload);

    res.status(201).json({
      success: true,
      data: workout,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};
