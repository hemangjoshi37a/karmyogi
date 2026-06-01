// This file is a part of "Candle" application (hjLabs.in fork).
// Automatic-soldering workbench panel — UI for the cadcam soldering generator.
// Copyright 2026 hjLabs.in / Hemang Joshi

#ifndef SOLDERINGWIDGET_H
#define SOLDERINGWIDGET_H

#include <QWidget>
#include <QStringList>

class QTableWidget;
class QDoubleSpinBox;
class QPlainTextEdit;
class QLabel;
class QCheckBox;
class QTimer;

// Table-driven panel for automatic soldering: a soldering iron at the head
// touches down at listed X/Y/Z points while the spindle output (repurposed as a
// solder-wire feeder) runs for a per-point time. Two feed strategies per point:
// pre-solder (feed onto the tip while raised, then dab) or touch-down (touch
// the pad first, then feed). "Generate NC code" emits a program for the
// existing visualizer/sender.
class SolderingWidget : public QWidget
{
    Q_OBJECT

public:
    explicit SolderingWidget(QWidget *parent = nullptr);

    // Per-panel zoom percentage (100 == 1.0x). Used by the dock title bar.
    int zoomPercent() const { return int(qRound(m_zoom * 100.0)); }

signals:
    void programGenerated(const QStringList &lines);
    void statusMessage(const QString &message);
    // Emitted whenever the panel zoom changes (percent, 100 == 1.0x).
    void zoomChanged(int percent);

public slots:
    // Fed the live machine work-position by the main window so "Record" can
    // capture it into a point.
    void setLivePosition(double x, double y, double z);

    // Per-panel zoom controls, driven from the dock title bar.
    void zoomIn();
    void zoomOut();
    void zoomReset();

private slots:
    void addRow();
    void deleteSelectedRows();
    void addDemoPoints();
    void recordPosition();
    void generate();
    void scheduleLivePreview();

private:
    QTableWidget *m_table = nullptr;
    QDoubleSpinBox *m_safeZ = nullptr;
    QDoubleSpinBox *m_feederRPM = nullptr;
    QDoubleSpinBox *m_plungeFeed = nullptr;
    QDoubleSpinBox *m_settle = nullptr;
    QPlainTextEdit *m_preview = nullptr;
    QLabel *m_info = nullptr;
    QLabel *m_liveLabel = nullptr;
    QCheckBox *m_livePreview = nullptr;
    QTimer *m_liveTimer = nullptr;

    double m_liveX = 0.0;
    double m_liveY = 0.0;
    double m_liveZ = 0.0;

    void appendRow(double x, double y, double freeZ, double touchZ, int typeIndex,
                   double feedSeconds);
    double cellValue(int row, int col) const;
    void setCell(int row, int col, double value);

    // Per-panel zoom: scales this widget's subtree font via a widget stylesheet
    // font-size (overrides the app-wide QSS font-size for this panel only).
    double m_zoom = 1.0;
    void applyZoom();
};

#endif // SOLDERINGWIDGET_H
