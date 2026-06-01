// This file is a part of "Candle" application (hjLabs.in fork).
// Motion / Limits settings panel — reads/writes GRBL firmware `$` settings
// (limit switches, homing, per-axis steps/mm, max travel, max rate and
// linear acceleration). GRBL has no S-curves; acceleration is linear only.
// Copyright 2026 hjLabs.in / Hemang Joshi

#ifndef MOTIONWIDGET_H
#define MOTIONWIDGET_H

#include <QWidget>
#include <QString>
#include <map>

class QCheckBox;
class QDoubleSpinBox;
class QSpinBox;
class QLabel;
class QLayout;

// A dockable panel that configures the GRBL controller's motion settings.
// It owns no cadcam core; it talks to the controller purely through signals:
// "Read from controller" requests "$$", incoming setting echoes arrive via
// onResponseLine(), and "Apply" sends "$<n>=<value>" lines back. The
// orchestrator (frmMain) wires commandRequested() to the sender and feeds
// every GRBL response line into onResponseLine().
class MotionWidget : public QWidget
{
    Q_OBJECT

public:
    explicit MotionWidget(QWidget *parent = nullptr);

    // Per-panel zoom percentage (100 == 1.0x). Used by the dock title bar.
    int zoomPercent() const { return int(qRound(m_zoom * 100.0)); }

signals:
    // A GRBL line to send to the controller (e.g. "$$" or "$120=10.000").
    void commandRequested(const QString &gcode);
    void statusMessage(const QString &message);
    // Emitted whenever the panel zoom changes (percent, 100 == 1.0x).
    void zoomChanged(int percent);

public slots:
    // Per-panel zoom controls, driven from the dock title bar.
    void zoomIn();
    void zoomOut();
    void zoomReset();

    // Parse a GRBL setting echo like "$120=10.000" (also tolerates "$120 = 10.0")
    // and update the matching field + cached value. Non-setting lines are ignored.
    void onResponseLine(const QString &line);

private slots:
    void readFromController();
    void applyChanged();
    void applyAll();

private:
    // How a setting's value is formatted on the wire and displayed.
    enum class Kind { Bool, Int, Real };

    struct Field {
        int num = 0;            // GRBL setting number ($num)
        Kind kind = Kind::Real;
        QWidget *widget = nullptr;
    };

    std::map<int, Field> m_fields;       // $num -> field descriptor
    std::map<int, double> m_lastRead;    // $num -> last value read/applied

    // Register a control against its $ number so read/apply/onResponseLine all
    // share one mapping.
    void registerField(int num, Kind kind, QWidget *widget);
    QCheckBox *addBool(class QFormLayout *form, int num, const QString &label);
    QSpinBox *addInt(class QFormLayout *form, int num, const QString &label,
                     int min, int max, const QString &suffix = QString());
    QDoubleSpinBox *addReal(class QFormLayout *form, int num, const QString &label,
                            double min, double max, const QString &suffix = QString());

    double fieldValue(const Field &f) const;
    void setFieldValue(const Field &f, double value);
    // Format a value for the wire: bool/int without decimals, real with 3.
    QString formatValue(const Field &f, double value) const;

    // Send every field whose value differs from m_lastRead (changedOnly=true),
    // or every field (changedOnly=false). Returns the number of lines sent.
    int sendFields(bool changedOnly);

    // Per-panel zoom: scales this widget's subtree font via a widget stylesheet
    // font-size (overrides the app-wide QSS font-size for this panel only).
    double m_zoom = 1.0;
    void applyZoom();
};

#endif // MOTIONWIDGET_H
